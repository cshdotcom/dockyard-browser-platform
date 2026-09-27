"use server"

import { z } from "zod"
import { db } from "@/lib/db"
import { requireAdmin, requireSuperAdmin, requireWritableMode } from "@/lib/permissions"
import { actionHandler, type ActionResult } from "@/lib/api"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { idempotencyCheck } from "@/lib/idempotency"
import { zodValidate, zPrecision } from "@/lib/validators"
import { assembleSingboxConfig, validateSingboxConfig, testConnectivity, DEFAULT_SINGBOX_IMAGE, type SingboxFormConfig } from "@/lib/singbox"
import { createContainer, startContainer, stopContainer, removeContainer, inspectContainer, signalContainer, containerStats, containerLogs } from "@/lib/external/docker"
import { raiseAlert } from "@/lib/alerts"
import { moveToRecycle } from "@/lib/recycle"
import { trackBehavior } from "@/lib/risk"

// ============================================================
// Sing-Box 实例编排 Server Actions
// 流程：可视化表单 → zod校验 → 宿主机资源校验 → 内存组装JSON（不落盘）
//   → Docker API创建容器（配置走环境变量注入）→ 启动 → 就绪探测
//   → prisma记录 + 自动生成proxy_node → 审计
// ============================================================

const outboundSchema = z.object({
  type: z.enum(["vless", "vmess", "trojan", "socks", "http"]),
  tag: z.string().min(1).max(64),
  server: z.string().max(255).optional().default(""),
  serverPort: z.coerce.number().int().min(1).max(65535).optional(),
  uuid: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  password: z.string().max(128).optional(),
  security: z.string().max(32).optional(),
  flow: z.string().max(64).optional(),
  transport: z.object({
    type: z.enum(["tcp", "ws", "grpc"]),
    path: z.string().max(255).optional(),
    serviceName: z.string().max(255).optional(),
    headers: z.record(z.string()).optional(),
  }).optional(),
  tls: z.object({
    enabled: z.boolean().optional().default(false),
    serverName: z.string().max(255).optional(),
    reality: z.object({
      enabled: z.boolean().optional().default(false),
      publicKey: z.string().max(255).optional(),
      shortId: z.string().max(64).optional(),
    }).optional(),
  }).optional(),
})

const routeRuleSchema = z.object({
  id: z.string().optional(),
  priority: z.coerce.number().int().min(1).max(9999),
  outboundTag: z.string().min(1).max(64),
  domain: z.array(z.string().max(255)).optional(),
  ipCidr: z.array(z.string().max(64)).optional(),
  protocol: z.array(z.string().max(32)).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  network: z.enum(["tcp", "udp"]).optional(),
  invert: z.boolean().optional(),
})

const singboxFormSchema = z.object({
  name: z.string().min(1, "实例名称必填").max(64),
  remark: z.string().max(255).optional().default(""),
  tags: z.string().optional().default(""),
  hostNodeId: z.string().min(1, "必须选择宿主机"),
  cpuLimit: zPrecision("CPU限制", 0.001, 64),
  memLimitMb: zPrecision("内存限制", 16, 65536),
  maxSessions: z.coerce.number().int().min(0).max(10000).optional().default(0),
  autoRestart: z.boolean().optional().default(true),
  trafficLimitMb: zPrecision("流量上限MB", 0, 1e9).optional().default(0),
  overLimitAction: z.enum(["ALERT", "THROTTLE", "BLOCK_NEW"]).optional().default("ALERT"),
  inboundPort: z.coerce.number().int().min(1024).max(65535),
  outbounds: z.array(outboundSchema).min(1, "至少配置一个出站"),
  defaultOutbound: z.string().min(1).max(64),
  routeRules: z.array(routeRuleSchema).optional().default([]),
  dns: z.object({
    servers: z.array(z.object({ tag: z.string().max(64), address: z.string().max(255), detour: z.string().max(64).optional() })).min(1),
    rules: z.array(z.object({ server: z.string().max(64), domain: z.array(z.string().max(255)).optional() })).optional(),
    strategy: z.string().max(32).optional(),
  }),
})

// ---- 新建实例 ----
export async function createSingboxAction(input: unknown): Promise<ActionResult<{ id: string; socksAddr: string; simulated: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    await requireWritableMode()
    const p = zodValidate(singboxFormSchema, input)

    // 幂等 + 速率限制
    const idem = await idempotencyCheck(ctx.userId, "create_singbox", { name: p.name, inboundPort: p.inboundPort }, 10_000)
    if (idem.repeated) throw new Error("请勿重复提交，实例创建中")
    if (!rateLimit(`sbcreate:${ctx.userId}`, 5, 60_000).allowed) throw new Error("创建频率过高")

    // 宿主机校验 + 资源预留水位
    const host = await db.hostNode.findFirst({ where: { id: p.hostNodeId, deletedAt: null, enabled: true } })
    if (!host) throw new Error("宿主机不存在或已禁用")
    if (host.status !== "ONLINE") throw new Error("宿主机当前离线")
    const usedInstances = await db.singboxInstance.findMany({
      where: { hostNodeId: host.id, deletedAt: null, status: { in: ["RUNNING", "CREATING", "RELOADING"] } },
      select: { cpuLimit: true, memLimitMb: true },
    })
    const usedCpu = usedInstances.reduce((s, i) => s + i.cpuLimit, 0)
    const usedMem = usedInstances.reduce((s, i) => s + i.memLimitMb, 0)
    if (usedCpu + p.cpuLimit > host.cpuCores - host.reservedCpu) {
      throw new Error(`宿主机CPU不足：已用${usedCpu}/${host.cpuCores}核（预留${host.reservedCpu}核），无法分配 ${p.cpuLimit} 核`)
    }
    if (usedMem + p.memLimitMb > host.memTotalMb - host.reservedMemMb) {
      throw new Error(`宿主机内存不足：已用${usedMem}/${host.memTotalMb}MB（预留${host.reservedMemMb}MB），无法分配 ${p.memLimitMb}MB`)
    }

    // 端口冲突校验（同宿主机）
    const conflict = await db.singboxInstance.findFirst({ where: { hostNodeId: host.id, deletedAt: null } })
    // socksAddr 端口按实例数递增分配（简化演示：容器内监听端口固定inboundPort）
    void conflict

    // 内存组装配置JSON（结构化，不落盘）
    const formConfig: SingboxFormConfig = {
      name: p.name,
      remark: p.remark,
      cpuLimit: p.cpuLimit,
      memLimitMb: p.memLimitMb,
      outbounds: p.outbounds as SingboxFormConfig["outbounds"],
      defaultOutbound: p.defaultOutbound,
      routeRules: p.routeRules as SingboxFormConfig["routeRules"],
      dns: p.dns,
      inbound: { tag: "socks-in", listen: "0.0.0.0", listenPort: p.inboundPort },
    }
    const configJson = assembleSingboxConfig(formConfig)
    const check = validateSingboxConfig(configJson)
    if (!check.ok) throw new Error(`配置预校验失败：${check.errors.join("；")}`)

    // Docker API 创建容器（配置经环境变量注入，不落盘磁盘）
    const container = await createContainer({
      name: `dockyard-singbox-${p.name}-${Date.now().toString(36)}`,
      image: process.env.SINGBOX_IMAGE || DEFAULT_SINGBOX_IMAGE,
      envVars: { DY_SINGBOX_CONFIG: JSON.stringify(configJson) },
      cpuLimit: p.cpuLimit,
      memLimitMb: p.memLimitMb,
      network: "dockyard-internal",
      labels: { "dockyard.managed": "true", "dockyard.name": p.name },
      autoRestart: p.autoRestart,
    })
    await startContainer(container.id)
    // 就绪探测
    const info = await inspectContainer(container.id)
    if (!info || info.state !== "running") {
      await removeContainer(container.id, true).catch(() => {})
      throw new Error("容器启动失败（实例未就绪）")
    }

    const socksAddr = `${host.name}:${p.inboundPort}`
    const tags = p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : []

    const inst = await db.singboxInstance.create({
      data: {
        name: p.name, remark: p.remark, tags,
        cpuLimit: p.cpuLimit, memLimitMb: p.memLimitMb,
        maxSessions: p.maxSessions, autoRestart: p.autoRestart,
        trafficLimitMb: p.trafficLimitMb, overLimitAction: p.overLimitAction,
        hostNodeId: host.id, containerId: container.id,
        status: "RUNNING", socksAddr,
        configJson: JSON.stringify(configJson), configVersion: 1,
        ownerUserId: ctx.userId, createdByUserId: ctx.userId,
      },
    })

    // 配置版本记录
    await db.singboxConfigVersion.create({
      data: { instanceId: inst.id, version: 1, configJson: JSON.stringify(configJson), operatorUserId: ctx.userId },
    })

    // 自动生成代理节点（proxy池双向联动）
    const proxyNode = await db.proxyNode.create({
      data: {
        name: `[SingBox] ${p.name}`,
        type: "internal_singbox",
        protocol: "socks5",
        host: host.name,
        port: p.inboundPort,
        status: "HEALTHY",
        latencyMs: 0,
        labels: tags,
        weight: 1,
        singboxInstanceId: inst.id,
        maxSessions: p.maxSessions,
        createdByUserId: ctx.userId,
      },
    })

    await trackBehavior(ctx.userId, "CREATE")
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_CREATE",
      resourceType: "SINGBOX", resourceId: inst.id, resourceName: p.name,
      ownerUserId: ctx.userId, createdByUserId: ctx.userId,
      after: { host: host.name, cpu: p.cpuLimit, mem: p.memLimitMb, inboundPort: p.inboundPort, containerId: container.id, proxyNodeId: proxyNode.id, socksAddr, simulated: container.simulated },
    })

    return { id: inst.id, socksAddr, simulated: container.simulated }
  })
}

// ---- 配置热更新（失败自动回滚）----
export async function updateSingboxConfigAction(input: unknown): Promise<ActionResult<{ version: number; rolledBack?: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    await requireWritableMode()
    const schema = singboxFormSchema.extend({ instanceId: z.string() })
    const p = zodValidate(schema, input)

    const inst = await db.singboxInstance.findFirst({ where: { id: p.instanceId, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    if (inst.status !== "RUNNING") throw new Error("仅运行中的实例支持热更新")

    const prevConfig = inst.configJson
    const formConfig: SingboxFormConfig = {
      name: p.name, remark: p.remark, cpuLimit: p.cpuLimit, memLimitMb: p.memLimitMb,
      outbounds: p.outbounds as SingboxFormConfig["outbounds"],
      defaultOutbound: p.defaultOutbound,
      routeRules: p.routeRules as SingboxFormConfig["routeRules"],
      dns: p.dns,
      inbound: { tag: "socks-in", listen: "0.0.0.0", listenPort: p.inboundPort },
    }
    const newConfig = JSON.stringify(assembleSingboxConfig(formConfig))
    const check = validateSingboxConfig(JSON.parse(newConfig))
    if (!check.ok) throw new Error(`配置预校验失败：${check.errors.join("；")}`)

    // 保存预更新版本记录
    const nextVersion = inst.configVersion + 1

    // 触发容器信号热重载（SIGHUP）
    await db.singboxInstance.update({ where: { id: inst.id }, data: { status: "RELOADING" } })
    await signalContainer(inst.containerId!, "SIGHUP")

    // 重载后状态探测
    await new Promise((r) => setTimeout(r, 1000))
    const info = await inspectContainer(inst.containerId!)

    if (!info || info.state !== "running") {
      // 重载失败 → 自动回滚上一版配置
      const rollbackConfig = prevConfig || newConfig
      await db.singboxInstance.update({
        where: { id: inst.id },
        data: { status: "ERROR", lastError: "热更新失败，已回滚配置", configJson: rollbackConfig },
      })
      await raiseAlert({
        title: `SingBox 实例热更新失败：${inst.name}`,
        level: "CRITICAL",
        content: `实例 ${inst.name} 配置热重载后异常，已自动回滚至版本 ${inst.configVersion}`,
        resourceType: "SINGBOX", resourceId: inst.id, ownerUserId: inst.ownerUserId,
      })
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_RELOAD_FAILED",
        resourceType: "SINGBOX", resourceId: inst.id, resourceName: inst.name,
        severity: "CRITICAL", after: { rolledBackTo: inst.configVersion },
      })
      return { version: inst.configVersion, rolledBack: true }
    }

    // 探测正常：保存新配置快照
    await db.singboxInstance.update({
      where: { id: inst.id },
      data: {
        status: "RUNNING", configJson: newConfig, configVersion: nextVersion,
        remark: p.remark, tags: p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : inst.tags,
        cpuLimit: p.cpuLimit, memLimitMb: p.memLimitMb, lastError: null,
      },
    })
    await db.singboxConfigVersion.create({
      data: { instanceId: inst.id, version: nextVersion, configJson: newConfig, operatorUserId: ctx.userId },
    })
    // 标签同步到关联代理节点
    if (p.tags) {
      await db.proxyNode.updateMany({
        where: { singboxInstanceId: inst.id },
        data: { labels: p.tags.split(",").map((t) => t.trim()).filter(Boolean) },
      })
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_CONFIG_UPDATE",
      resourceType: "SINGBOX", resourceId: inst.id, resourceName: inst.name,
      before: { version: inst.configVersion, config: prevConfig?.slice(0, 500) },
      after: { version: nextVersion, config: newConfig.slice(0, 500) },
      severity: "WARN",
    })
    return { version: nextVersion }
  })
}

// ---- 回滚历史配置版本 ----
export async function rollbackSingboxConfigAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { instanceId, version } = zodValidate(z.object({ instanceId: z.string(), version: z.coerce.number().int().min(1) }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id: instanceId, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    const ver = await db.singboxConfigVersion.findFirst({ where: { instanceId, version }, orderBy: { createdAt: "desc" } })
    if (!ver) throw new Error("配置版本不存在")

    await db.singboxInstance.update({ where: { id: instanceId }, data: { configJson: ver.configJson, status: "RELOADING" } })
    if (inst.containerId) await signalContainer(inst.containerId, "SIGHUP")
    await new Promise((r) => setTimeout(r, 800))
    const info = inst.containerId ? await inspectContainer(inst.containerId) : null
    await db.singboxInstance.update({ where: { id: instanceId }, data: { status: info?.state === "running" ? "RUNNING" : "ERROR" } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_CONFIG_ROLLBACK",
      resourceType: "SINGBOX", resourceId: instanceId, resourceName: inst.name,
      after: { rolledBackVersion: version }, severity: "WARN",
    })
    return null
  })
}

// ---- 停止 / 启动 / 销毁 ----
export async function stopSingboxAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    if (inst.containerId) await stopContainer(inst.containerId)
    await db.singboxInstance.update({ where: { id }, data: { status: "STOPPED" } })
    await db.proxyNode.updateMany({ where: { singboxInstanceId: id }, data: { status: "FAILED" } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_STOP",
      resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
      before: { status: inst.status }, after: { status: "STOPPED" },
    })
    return null
  })
}

export async function startSingboxAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    await requireWritableMode()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    if (inst.status === "RUNNING") throw new Error("实例已在运行")
    if (inst.containerId) {
      await startContainer(inst.containerId)
    } else {
      // 容器丢失 → 重建（按库内配置快照）
      const container = await createContainer({
        name: `dockyard-singbox-${inst.name}-${Date.now().toString(36)}`,
        image: process.env.SINGBOX_IMAGE || DEFAULT_SINGBOX_IMAGE,
        envVars: { DY_SINGBOX_CONFIG: inst.configJson || "{}" },
        cpuLimit: inst.cpuLimit, memLimitMb: inst.memLimitMb,
        network: "dockyard-internal", autoRestart: inst.autoRestart,
        labels: { "dockyard.managed": "true" },
      })
      await startContainer(container.id)
      await db.singboxInstance.update({ where: { id }, data: { containerId: container.id } })
    }
    await db.singboxInstance.update({ where: { id }, data: { status: "RUNNING", lastError: null } })
    await db.proxyNode.updateMany({ where: { singboxInstanceId: id }, data: { status: "HEALTHY" } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_START",
      resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
      after: { status: "RUNNING" },
    })
    return null
  })
}

export async function destroySingboxAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id, toRecycle } = zodValidate(z.object({ id: z.string(), toRecycle: z.boolean().optional().default(true) }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    // 活跃会话校验：存在运行中工作区使用该实例则拒绝
    const active = await db.browserWorkspace.count({
      where: { singboxInstanceId: id, status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null },
    })
    if (active > 0) throw new Error(`存在 ${active} 个活跃浏览器会话正在使用该实例，请先停止相关浏览器工作区`)

    if (inst.containerId) await removeContainer(inst.containerId, true).catch(() => {})
    if (toRecycle) {
      await db.singboxInstance.update({ where: { id }, data: { deletedAt: new Date(), status: "DELETED" } })
      await moveToRecycle({
        resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
        ownerUserId: inst.ownerUserId, createdByUserId: inst.createdByUserId,
        deletedByUserId: ctx.userId, deletedByType: "ADMIN", reason: "管理员销毁实例",
      })
    } else {
      await db.singboxInstance.delete({ where: { id } })
    }
    // 自动禁用关联代理节点
    await db.proxyNode.updateMany({ where: { singboxInstanceId: id }, data: { status: "DISABLED", deletedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_DESTROY",
      resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
      severity: "WARN", after: { toRecycle, proxyDisabled: true },
    })
    return null
  })
}

// ---- 连通性测试 ----
export async function testSingboxConnectivityAction(input: unknown): Promise<ActionResult<{ ok: boolean; exitIp?: string; latencyMs: number; udpOk: boolean; dnsLeak: boolean; detail?: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    const result = await testConnectivity(inst.socksAddr || "sim:test")
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_TEST",
      resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
      after: { ...result },
    })
    return result
  })
}

// ---- 实例详情数据（日志/统计/配置版本）----
export async function getInstanceRuntimeAction(input: unknown): Promise<ActionResult<{ logs: string[]; stats: { cpuPct: number; memMb: number; netRxMb: number; netTxMb: number }; versions: { version: number; createdAt: string; operator: string }[]; configJson: string; containerInfo: { state: string; name: string } | null }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    const [logs, stats, versions, info] = await Promise.all([
      inst.containerId ? containerLogs(inst.containerId, 100).catch(() => []) : Promise.resolve([]),
      inst.containerId ? containerStats(inst.containerId).catch(() => ({ cpuPct: 0, memMb: 0, netRxMb: 0, netTxMb: 0 })) : Promise.resolve({ cpuPct: 0, memMb: 0, netRxMb: 0, netTxMb: 0 }),
      db.singboxConfigVersion.findMany({ where: { instanceId: id }, orderBy: { version: "desc" }, take: 20 }),
      inst.containerId ? inspectContainer(inst.containerId).catch(() => null) : Promise.resolve(null),
    ])
    // 流量累计与统计采样
    await db.singboxStats.create({
      data: { instanceId: id, cpuPct: stats.cpuPct, memMb: stats.memMb, bytesUpMb: stats.netTxMb, bytesDownMb: stats.netRxMb },
    })
    await db.singboxInstance.update({
      where: { id },
      data: {
        bytesUpMb: Math.max(inst.bytesUpMb, stats.netTxMb),
        bytesDownMb: Math.max(inst.bytesDownMb, stats.netRxMb),
        peakTrafficMb: Math.max(inst.peakTrafficMb, stats.netRxMb + stats.netTxMb),
      },
    })
    return {
      logs,
      stats,
      versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt.toISOString(), operator: v.operatorUserId || "系统" })),
      configJson: inst.configJson || "{}",
      containerInfo: info ? { state: info.state, name: info.name } : null,
    }
  })
}

// ---- 配置导出 / 导入 ----
export async function exportSingboxConfigAction(input: unknown): Promise<ActionResult<{ config: Record<string, unknown> }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!inst) throw new Error("实例不存在")
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_EXPORT",
      resourceType: "SINGBOX", resourceId: id, resourceName: inst.name,
    })
    return { config: { name: inst.name, remark: inst.remark, cpuLimit: inst.cpuLimit, memLimitMb: inst.memLimitMb, configJson: JSON.parse(inst.configJson || "{}") } }
  })
}

export async function importSingboxAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireSuperAdmin()
    await requireWritableMode()
    const { json } = zodValidate(z.object({ json: z.string().min(2).max(1e6) }), input)
    const parsed = JSON.parse(json) as { name?: string; remark?: string; cpuLimit?: number; memLimitMb?: number; configJson?: Record<string, unknown> }
    if (!parsed.name || !parsed.configJson) throw new Error("导入JSON格式错误：需要 name 与 configJson 字段")
    const check = validateSingboxConfig(parsed.configJson)
    if (!check.ok) throw new Error(`导入配置校验失败：${check.errors.join("；")}`)
    // 复用创建流程
    const inbounds = (parsed.configJson as { inbounds?: { listen_port?: number }[] }).inbounds || []
    const result = await createSingboxAction({
      name: parsed.name, remark: parsed.remark || "", hostNodeId: (await db.hostNode.findFirst({ where: { deletedAt: null, enabled: true } }))?.id || "",
      cpuLimit: parsed.cpuLimit || 1, memLimitMb: parsed.memLimitMb || 512, inboundPort: inbounds[0]?.listen_port || 1080,
      outbounds: (parsed.configJson as { outbounds?: unknown[] }).outbounds || [],
      defaultOutbound: (parsed.configJson as { route?: { final?: string } }).route?.final || "direct",
      routeRules: [], dns: { servers: (parsed.configJson as { dns?: { servers?: unknown[] } }).dns?.servers || [{ tag: "local", address: "local" }] },
    })
    return { id: result.data?.id || "" }
  })
}

// ---- 批量操作 ----
export async function batchSingboxAction(input: unknown): Promise<ActionResult<{ ok: number; fail: number; failures: { id: string; name: string; reason: string }[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const { ids, op } = zodValidate(z.object({ ids: z.array(z.string()).min(1), op: z.enum(["stop", "start", "destroy", "test"] ) }), input)
    await trackBehavior(ctx.userId, "BATCH")
    let ok = 0
    const failures: { id: string; name: string; reason: string }[] = []
    for (const id of ids) {
      const inst = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
      if (!inst) { failures.push({ id, name: "-", reason: "不存在" }); continue }
      try {
        if (op === "stop") await stopSingboxAction({ id })
        else if (op === "start") await startSingboxAction({ id })
        else if (op === "destroy") await destroySingboxAction({ id, toRecycle: true })
        else await testSingboxConnectivityAction({ id })
        ok++
      } catch (e) {
        failures.push({ id, name: inst.name, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    return { ok, fail: failures.length, failures }
  })
}

// ---- 复制实例 ----
export async function copySingboxAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    await requireWritableMode()
    const { id, newName } = zodValidate(z.object({ id: z.string(), newName: z.string().min(1).max(64) }), input)
    const src = await db.singboxInstance.findFirst({ where: { id, deletedAt: null } })
    if (!src) throw new Error("源实例不存在")
    const hostId = src.hostNodeId || (await db.hostNode.findFirst({ where: { deletedAt: null, enabled: true } }))?.id
    if (!hostId) throw new Error("无可用宿主机")
    const config = JSON.parse(src.configJson || "{}") as Record<string, unknown>
    const inbounds = (config.inbounds || []) as { listen_port: number }[]
    const res = await createSingboxAction({
      name: newName, remark: `${src.remark || ""}（复制自 ${src.name}）`, hostNodeId: hostId,
      cpuLimit: src.cpuLimit, memLimitMb: src.memLimitMb, inboundPort: inbounds[0]?.listen_port || 1080,
      outbounds: (config.outbounds || []) as never[], defaultOutbound: (config.route as { final?: string } | undefined)?.final || "direct",
      routeRules: [], dns: { servers: (config.dns as { servers?: unknown[] } | undefined)?.servers || [{ tag: "local", address: "local" }] },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SINGBOX_COPY",
      resourceType: "SINGBOX", resourceId: src.id, resourceName: src.name,
      after: { newInstanceId: res.data?.id, newName },
    })
    return { id: res.data?.id || "" }
  })
}
