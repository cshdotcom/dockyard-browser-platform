"use server"

// 网络与节点管理：代理节点 / 浏览器节点 / 宿主机（管理员）
// 全部真实实现：CRUD + 健康探测 + 批量启停 + 水位告警 + 审计 + 回收站

import { Prisma } from "@prisma/client"
import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId, zPrecision } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { raiseAlert } from "@/lib/alerts"
import { encrypt } from "@/lib/crypto"
import { moveToRecycle } from "@/lib/recycle"
import { testConnectivity } from "@/lib/singbox"
import { nodeLoad } from "@/lib/external/browser-session"
import { hostInfo } from "@/lib/external/docker"

// ============================================================
// 代理节点 ProxyNode
// ============================================================

const proxyInputSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "名称不能为空").max(64),
  protocol: z.enum(["socks5", "http"]),
  host: z.string().min(1, "地址不能为空").max(190),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().max(190).optional().nullable(),
  password: z.string().max(190).optional().nullable(), // 留空=编辑时保持不变
  labels: z.array(z.string().max(32)).max(16).optional().nullable(),
  weight: zPrecision("权重", 0.001, 100000),
  maxSessions: z.coerce.number().int().min(0).max(100000),
  scheduleStrategy: z.enum(["WEIGHT", "ROUND_ROBIN", "LEAST_LOAD", "AFFINITY"]),
})

export async function createProxyNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(proxyInputSchema, input)
    const node = await db.proxyNode.create({
      data: {
        name: p.name,
        type: "external",
        protocol: p.protocol,
        host: p.host,
        port: p.port,
        username: p.username || null,
        password: p.password ? encrypt(p.password) : null,
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        weight: Math.max(1, Math.round(p.weight)),
        maxSessions: p.maxSessions,
        scheduleStrategy: p.scheduleStrategy,
        status: "HEALTHY",
        createdByUserId: ctx.userId,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PROXY_NODE_CREATE",
      resourceType: "PROXY_NODE",
      resourceId: node.id,
      resourceName: node.name,
      createdByUserId: ctx.userId,
      after: { name: node.name, type: node.type, protocol: node.protocol, host: node.host, port: node.port },
    })
    return { id: node.id }
  })
}

export async function updateProxyNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(proxyInputSchema, input)
    if (!p.id) throw new Error("缺少节点ID")
    const existing = await db.proxyNode.findUnique({ where: { id: p.id } })
    if (!existing || existing.deletedAt) throw new Error("代理节点不存在")
    // 仅 external 类型可编辑连接信息
    if (existing.type !== "external") {
      throw new Error("internal_singbox 类型节点由 SingBox 实例管理维护，请前往 SingBox 实例管理")
    }
    const node = await db.proxyNode.update({
      where: { id: p.id },
      data: {
        name: p.name,
        protocol: p.protocol,
        host: p.host,
        port: p.port,
        username: p.username || null,
        ...(p.password ? { password: encrypt(p.password) } : {}),
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        weight: Math.max(1, Math.round(p.weight)),
        maxSessions: p.maxSessions,
        scheduleStrategy: p.scheduleStrategy,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PROXY_NODE_UPDATE",
      resourceType: "PROXY_NODE",
      resourceId: node.id,
      resourceName: node.name,
      ownerUserId: null,
      createdByUserId: existing.createdByUserId,
      before: { name: existing.name, protocol: existing.protocol, host: existing.host, port: existing.port, weight: existing.weight, maxSessions: existing.maxSessions, scheduleStrategy: existing.scheduleStrategy },
      after: { name: node.name, protocol: node.protocol, host: node.host, port: node.port, weight: node.weight, maxSessions: node.maxSessions, scheduleStrategy: node.scheduleStrategy, passwordChanged: !!p.password },
    })
    return { id: node.id }
  })
}

export async function deleteProxyNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.proxyNode.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("代理节点不存在")
    // 前置检查：仍有工作区绑定该节点则提示
    const binding = await db.browserWorkspace.count({ where: { proxyNodeId: id, deletedAt: null, status: { in: ["CREATING", "RUNNING", "IDLE"] } } })
    if (binding > 0) throw new Error(`仍有 ${binding} 个运行中工作区绑定该节点，请先解绑或停止`)
    await db.proxyNode.update({ where: { id }, data: { deletedAt: new Date(), status: "DISABLED" } })
    await moveToRecycle({
      resourceType: "PROXY_NODE",
      resourceId: id,
      resourceName: existing.name,
      createdByUserId: existing.createdByUserId,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: `管理员删除代理节点 ${existing.name}`,
      operatorName: ctx.username,
    })
    return { id }
  })
}

// 健康探测：external 直连/对照测试；internal_singbox 读关联实例 socksAddr
export async function probeProxyNodeAction(input: unknown): Promise<ActionResult<{ id: string; ok: boolean; latencyMs: number; status: string; exitIp?: string; detail?: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const node = await db.proxyNode.findUnique({ where: { id } })
    if (!node || node.deletedAt) throw new Error("代理节点不存在")
    if (node.status === "DISABLED") throw new Error("节点已停用，请先启用再探测")

    let probeAddr: string
    if (node.type === "internal_singbox") {
      if (!node.singboxInstanceId) throw new Error("internal_singbox 节点未关联 SingBox 实例")
      const sbi = await db.singboxInstance.findUnique({ where: { id: node.singboxInstanceId } })
      if (!sbi || sbi.deletedAt) throw new Error("关联的 SingBox 实例不存在")
      if (!sbi.socksAddr) throw new Error("关联的 SingBox 实例未就绪（无 socks 地址）")
      probeAddr = sbi.socksAddr
    } else {
      if (!node.host || !node.port) throw new Error("节点缺少 host/port 连接信息")
      probeAddr = `${node.protocol === "http" ? "http" : "socks"}://${node.host}:${node.port}`
    }

    const result = await testConnectivity(probeAddr)
    let newStatus: string
    let failCount = node.healthFailCount
    if (result.ok) {
      newStatus = "HEALTHY"
      failCount = 0
    } else {
      failCount = node.healthFailCount + 1
      newStatus = failCount >= 3 ? "FAILED" : node.status === "HEALTHY" ? "DEGRADED" : node.status
    }
    const updated = await db.proxyNode.update({
      where: { id },
      data: { status: newStatus, latencyMs: Math.round(result.latencyMs * 1000) / 1000, healthFailCount: failCount },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PROXY_NODE_PROBE",
      resourceType: "PROXY_NODE",
      resourceId: id,
      resourceName: node.name,
      createdByUserId: node.createdByUserId,
      severity: result.ok ? "INFO" : failCount >= 3 ? "WARN" : "INFO",
      after: { probeAddr, ok: result.ok, latencyMs: updated.latencyMs, status: updated.status, healthFailCount: updated.healthFailCount, exitIp: result.exitIp },
    })
    if (!result.ok && newStatus === "FAILED") {
      await raiseAlert({
        title: "代理节点探测失败",
        level: "WARN",
        content: `代理节点 ${node.name}（${probeAddr}）连续 ${failCount} 次探测失败，已标记为 FAILED：${result.detail || "连接失败"}`,
        resourceType: "PROXY_NODE",
        resourceId: id,
        dedupeKey: `proxy-probe-fail-${id}`,
      })
    }
    return { id, ok: result.ok, latencyMs: updated.latencyMs, status: updated.status, exitIp: result.exitIp, detail: result.detail }
  })
}

// 批量启停：status 置 DISABLED / HEALTHY
export async function batchProxyStatusAction(input: unknown): Promise<ActionResult<{ successCount: number; failCount: number; failures: { id: string; reason: string }[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { ids, enable } = zodValidate(z.object({ ids: z.array(zId).min(1, "请选择节点"), enable: z.boolean() }), input)
    const failures: { id: string; reason: string }[] = []
    let successCount = 0
    for (const id of ids) {
      try {
        const node = await db.proxyNode.findUnique({ where: { id } })
        if (!node || node.deletedAt) throw new Error("节点不存在")
        await db.proxyNode.update({
          where: { id },
          data: enable ? { status: "HEALTHY", healthFailCount: 0 } : { status: "DISABLED" },
        })
        successCount++
      } catch (e) {
        failures.push({ id, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "PROXY_NODE_BATCH_STATUS",
      resourceType: "PROXY_NODE",
      severity: "WARN",
      extra: { ids, enable, successCount, failCount: failures.length, failures },
    })
    return { successCount, failCount: failures.length, failures }
  })
}

// ============================================================
// 浏览器节点 BrowserNode
// ============================================================

const browserNodeInputSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "名称不能为空").max(64),
  baseUrl: z.string().min(1, "baseUrl 不能为空").max(300),
  // r28：公网展示地址（可选；展示/拼接用，不参与拨号 —— baseUrl 始终为平台实际拨号地址）
  publicUrl: z.string().max(300).optional().nullable(),
  // r33：公网 CDP 接入地址（可选；工作区 CDP 面板对外展示，优先于 PUBLIC_BASE_URL 推导）
  publicCdpUrl: z.string().max(300).optional().nullable(),
  labels: z.array(z.string().max(32)).max(16).optional().nullable(),
  weight: zPrecision("权重", 0.001, 100000),
  grayGroup: z.enum(["PROD", "TEST"]),
  enabled: z.boolean(),
})

export async function createBrowserNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(browserNodeInputSchema, input)
    const node = await db.browserNode.create({
      data: {
        name: p.name,
        baseUrl: p.baseUrl,
        publicUrl: p.publicUrl?.trim() || null,
        publicCdpUrl: p.publicCdpUrl?.trim() || null,
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        weight: Math.max(1, Math.round(p.weight)),
        grayGroup: p.grayGroup,
        enabled: p.enabled,
        status: p.enabled ? "ONLINE" : "OFFLINE",
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BROWSER_NODE_CREATE",
      resourceType: "BROWSER_NODE",
      resourceId: node.id,
      resourceName: node.name,
      after: { name: node.name, baseUrl: node.baseUrl, publicUrl: node.publicUrl, publicCdpUrl: node.publicCdpUrl, grayGroup: node.grayGroup, weight: node.weight, enabled: node.enabled },
    })
    return { id: node.id }
  })
}

export async function updateBrowserNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(browserNodeInputSchema, input)
    if (!p.id) throw new Error("缺少节点ID")
    const existing = await db.browserNode.findUnique({ where: { id: p.id } })
    if (!existing || existing.deletedAt) throw new Error("浏览器节点不存在")
    const node = await db.browserNode.update({
      where: { id: p.id },
      data: {
        name: p.name,
        baseUrl: p.baseUrl,
        publicUrl: p.publicUrl?.trim() || null,
        publicCdpUrl: p.publicCdpUrl?.trim() || null,
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        weight: Math.max(1, Math.round(p.weight)),
        grayGroup: p.grayGroup,
        enabled: p.enabled,
        ...(existing.enabled !== p.enabled ? { status: p.enabled ? "ONLINE" : "OFFLINE" } : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BROWSER_NODE_UPDATE",
      resourceType: "BROWSER_NODE",
      resourceId: node.id,
      resourceName: node.name,
      before: { name: existing.name, baseUrl: existing.baseUrl, grayGroup: existing.grayGroup, weight: existing.weight, enabled: existing.enabled },
      after: { name: node.name, baseUrl: node.baseUrl, publicUrl: node.publicUrl, publicCdpUrl: node.publicCdpUrl, grayGroup: node.grayGroup, weight: node.weight, enabled: node.enabled },
    })
    return { id: node.id }
  })
}

// 灰度分组快速切换
export async function setBrowserNodeGrayGroupAction(input: unknown): Promise<ActionResult<{ id: string; grayGroup: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id, grayGroup } = zodValidate(z.object({ id: zId, grayGroup: z.enum(["PROD", "TEST"]) }), input)
    const existing = await db.browserNode.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("浏览器节点不存在")
    const node = await db.browserNode.update({ where: { id }, data: { grayGroup } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BROWSER_NODE_UPDATE",
      resourceType: "BROWSER_NODE",
      resourceId: id,
      resourceName: node.name,
      before: { grayGroup: existing.grayGroup },
      after: { grayGroup: node.grayGroup },
      extra: { change: "灰度分组切换" },
    })
    return { id, grayGroup: node.grayGroup }
  })
}

export async function deleteBrowserNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.browserNode.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("浏览器节点不存在")
    const binding = await db.browserWorkspace.count({ where: { browserNodeId: id, deletedAt: null, status: { in: ["CREATING", "RUNNING", "IDLE"] } } })
    if (binding > 0) throw new Error(`仍有 ${binding} 个运行中工作区调度在该节点，请先迁移`)
    await db.browserNode.update({ where: { id }, data: { deletedAt: new Date(), status: "OFFLINE" } })
    await moveToRecycle({
      resourceType: "BROWSER_NODE",
      resourceId: id,
      resourceName: existing.name,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: `管理员删除 浏览器节点 ${existing.name}`,
      operatorName: ctx.username,
    })
    return { id }
  })
}

// 浏览器节点探测：nodeLoad 成功→ONLINE+负载/会话更新；失败→probeFailCount+1，连续3次→ISOLATED+告警
export async function probeBrowserNodeAction(input: unknown): Promise<ActionResult<{ id: string; ok: boolean; status: string; loadScore: number; activeSessions: number; probeFailCount: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const node = await db.browserNode.findUnique({ where: { id } })
    if (!node || node.deletedAt) throw new Error("浏览器节点不存在")

    const load = await nodeLoad()
    let status = node.status
    let probeFailCount = node.probeFailCount
    let loadScore = node.loadScore
    let activeSessions = node.activeSessions
    if (load) {
      status = "ONLINE"
      probeFailCount = 0
      loadScore = Math.round(load.loadScore * 1000) / 1000
      activeSessions = load.activeSessions
    } else {
      probeFailCount = node.probeFailCount + 1
      status = probeFailCount >= 3 ? "ISOLATED" : node.status
    }
    const updated = await db.browserNode.update({ where: { id }, data: { status, probeFailCount, loadScore, activeSessions, enabled: node.enabled } })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "BROWSER_NODE_PROBE",
      resourceType: "BROWSER_NODE",
      resourceId: id,
      resourceName: node.name,
      severity: load ? "INFO" : probeFailCount >= 3 ? "WARN" : "INFO",
      after: { ok: !!load, status: updated.status, loadScore: updated.loadScore, activeSessions: updated.activeSessions, probeFailCount: updated.probeFailCount },
    })
    if (!load && status === "ISOLATED") {
      await raiseAlert({
        title: "浏览器节点已被隔离",
        level: "WARN",
        content: `浏览器节点 ${node.name}（${node.baseUrl}）连续 ${probeFailCount} 次探测失败，已自动隔离（ISOLATED），新会话将不再调度至该节点`,
        resourceType: "BROWSER_NODE",
        resourceId: id,
        dedupeKey: `browser-probe-fail-${id}`,
      })
    }
    return { id, ok: !!load, status: updated.status, loadScore: updated.loadScore, activeSessions: updated.activeSessions, probeFailCount: updated.probeFailCount }
  })
}

// ============================================================
// 宿主机 HostNode
// ============================================================

const hostInputSchema = z.object({
  id: zId.optional(),
  name: z.string().min(1, "名称不能为空").max(64),
  dockerApiUrl: z.string().min(1, "Docker API 地址不能为空").max(300),
  labels: z.array(z.string().max(32)).max(16).optional().nullable(),
  cpuCores: zPrecision("CPU核数", 0.001, 1024),
  memTotalMb: zPrecision("内存", 1, 1048576 * 8),
  reservedCpu: zPrecision("预留CPU", 0, 1024),
  reservedMemMb: zPrecision("预留内存", 0, 1048576 * 8),
  grayGroup: z.enum(["PROD", "TEST"]),
  enabled: z.boolean(),
})

export async function createHostNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(hostInputSchema, input)
    const node = await db.hostNode.create({
      data: {
        name: p.name,
        dockerApiUrl: p.dockerApiUrl,
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        cpuCores: p.cpuCores,
        memTotalMb: p.memTotalMb,
        reservedCpu: p.reservedCpu,
        reservedMemMb: p.reservedMemMb,
        grayGroup: p.grayGroup,
        enabled: p.enabled,
        status: p.enabled ? "ONLINE" : "OFFLINE",
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "HOST_NODE_CREATE",
      resourceType: "HOST_NODE",
      resourceId: node.id,
      resourceName: node.name,
      after: { name: node.name, dockerApiUrl: node.dockerApiUrl, cpuCores: node.cpuCores, memTotalMb: node.memTotalMb, reservedCpu: node.reservedCpu, reservedMemMb: node.reservedMemMb, grayGroup: node.grayGroup },
    })
    return { id: node.id }
  })
}

export async function updateHostNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(hostInputSchema, input)
    if (!p.id) throw new Error("缺少节点ID")
    const existing = await db.hostNode.findUnique({ where: { id: p.id } })
    if (!existing || existing.deletedAt) throw new Error("宿主机不存在")
    const node = await db.hostNode.update({
      where: { id: p.id },
      data: {
        name: p.name,
        dockerApiUrl: p.dockerApiUrl,
        labels: (p.labels?.length ? p.labels : Prisma.DbNull) as Prisma.InputJsonValue,
        cpuCores: p.cpuCores,
        memTotalMb: p.memTotalMb,
        reservedCpu: p.reservedCpu,
        reservedMemMb: p.reservedMemMb,
        grayGroup: p.grayGroup,
        enabled: p.enabled,
        ...(existing.enabled !== p.enabled ? { status: p.enabled ? "ONLINE" : "OFFLINE" } : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "HOST_NODE_UPDATE",
      resourceType: "HOST_NODE",
      resourceId: node.id,
      resourceName: node.name,
      before: { name: existing.name, dockerApiUrl: existing.dockerApiUrl, cpuCores: existing.cpuCores, memTotalMb: existing.memTotalMb, reservedCpu: existing.reservedCpu, reservedMemMb: existing.reservedMemMb, grayGroup: existing.grayGroup, enabled: existing.enabled },
      after: { name: node.name, dockerApiUrl: node.dockerApiUrl, cpuCores: node.cpuCores, memTotalMb: node.memTotalMb, reservedCpu: node.reservedCpu, reservedMemMb: node.reservedMemMb, grayGroup: node.grayGroup, enabled: node.enabled },
    })
    return { id: node.id }
  })
}

export async function deleteHostNodeAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const existing = await db.hostNode.findUnique({ where: { id } })
    if (!existing || existing.deletedAt) throw new Error("宿主机不存在")
    const binding = await db.singboxInstance.count({ where: { hostNodeId: id, deletedAt: null, status: { in: ["CREATING", "RUNNING", "RELOADING"] } } })
    if (binding > 0) throw new Error(`仍有 ${binding} 个运行中 SingBox 实例部署在该宿主机，请先迁移`)
    await db.hostNode.update({ where: { id }, data: { deletedAt: new Date(), status: "OFFLINE" } })
    await moveToRecycle({
      resourceType: "HOST_NODE",
      resourceId: id,
      resourceName: existing.name,
      deletedByUserId: ctx.userId,
      deletedByType: "ADMIN",
      reason: `管理员删除宿主机 ${existing.name}`,
      operatorName: ctx.username,
    })
    return { id }
  })
}

// 采集宿主机资源：真实模式读 NCPU/MemTotal；模拟模式更新水位（CPU 20-70、内存按比例）
export async function probeHostNodeAction(input: unknown): Promise<ActionResult<{ id: string; simulated: boolean; cpuCores: number; memTotalMb: number; cpuUsedPct: number; memUsedMb: number; diskUsedPct: number; alert?: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: zId }), input)
    const node = await db.hostNode.findUnique({ where: { id } })
    if (!node || node.deletedAt) throw new Error("宿主机不存在")

    const info = await hostInfo()
    const round3 = (n: number) => Math.round(n * 1000) / 1000
    let cpuUsedPct = node.cpuUsedPct
    let memUsedMb = node.memUsedMb
    let diskUsedPct = node.diskUsedPct

    if (info.simulated) {
      // 模拟模式：刷新模拟水位
      cpuUsedPct = round3(20 + Math.random() * 50)
      const ratio = 0.3 + Math.random() * 0.5
      memUsedMb = round3(info.memTotalMb * ratio)
      diskUsedPct = round3(Math.min(95, Math.max(5, (node.diskUsedPct || 30) + (Math.random() * 12 - 6))))
    } else {
      // 真实模式：/info 的 NCPU / MemTotal 更新容量（使用率由容器 stats 汇聚，此处保持）
      cpuUsedPct = node.cpuUsedPct
      memUsedMb = node.memUsedMb
      diskUsedPct = node.diskUsedPct
    }

    const updated = await db.hostNode.update({
      where: { id },
      data: { cpuCores: info.cpuCores, memTotalMb: info.memTotalMb, cpuUsedPct, memUsedMb, diskUsedPct },
    })

    // 水位告警：CPU>80% 或磁盘>85%
    let alertMsg: string | undefined
    if (cpuUsedPct > 80 || diskUsedPct > 85) {
      const reasons: string[] = []
      if (cpuUsedPct > 80) reasons.push(`CPU 使用率 ${cpuUsedPct.toFixed(1)}% 超过 80%`)
      if (diskUsedPct > 85) reasons.push(`磁盘使用率 ${diskUsedPct.toFixed(1)}% 超过 85%`)
      alertMsg = reasons.join("；")
      await raiseAlert({
        title: "宿主机资源水位告警",
        level: "WARN",
        content: `宿主机 ${node.name}（${node.dockerApiUrl}）${alertMsg}，请及时扩容或迁移实例`,
        resourceType: "HOST_NODE",
        resourceId: id,
        dedupeKey: `host-water-${id}`,
      })
    }
    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "HOST_NODE_PROBE",
      resourceType: "HOST_NODE",
      resourceId: id,
      resourceName: node.name,
      severity: alertMsg ? "WARN" : "INFO",
      after: { simulated: info.simulated, cpuCores: updated.cpuCores, memTotalMb: updated.memTotalMb, cpuUsedPct: updated.cpuUsedPct, memUsedMb: updated.memUsedMb, diskUsedPct: updated.diskUsedPct, waterLevelAlert: alertMsg || null },
    })
    return { id, simulated: info.simulated, cpuCores: updated.cpuCores, memTotalMb: updated.memTotalMb, cpuUsedPct: updated.cpuUsedPct, memUsedMb: updated.memUsedMb, diskUsedPct: updated.diskUsedPct, alert: alertMsg }
  })
}
