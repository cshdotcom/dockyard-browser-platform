"use server"

import { z } from "zod"
import crypto from "crypto"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireAuth, checkSessionQuota, userGroupIds, requireWritableMode, requirePermission } from "@/lib/permissions"
import { actionHandler, type ActionResult } from "@/lib/api"
import { writeAudit } from "@/lib/audit"
import { encrypt, decrypt, randomHex } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"
import { idempotencyCheck } from "@/lib/idempotency"
import { trackBehavior, detectAbnormalBehavior } from "@/lib/risk"
import { raiseAlert } from "@/lib/alerts"
import { zodValidate, zPrecision } from "@/lib/validators"
import { createSession, destroySession } from "@/lib/external/steel"
import { createNovncSession, destroyNovncSession, refreshNovncSecret, novncDialTarget, restartNovncBrowser, type NovncSession } from "@/lib/external/novnc"
import { browserHardeningSummary, restartBrowserProcessInContainer, type BrowserHardeningInfo } from "@/lib/external/docker"
import { resolveNetworkPolicy, type NetworkPolicy } from "@/lib/network-policy"
import { resolveAccessPolicies, resolveDomainPolicyForUser, type DomainPolicy } from "@/lib/domain-policy"
import { resolveEndpointPolicyForUser } from "@/lib/endpoint-policy"
import { ENV } from "@/lib/env"
import { moveToRecycle } from "@/lib/recycle"
import { getConfigBool, getConfig, getConfigNumber } from "@/lib/config"

// ============================================================
// 浏览器工作区业务 Server Actions
// 数据流：前端表单 → Server Action（权限+配额+幂等+风控校验）
//   → Steel-Browser/NoVNC 外部API → Prisma 落库 → 审计 → 返回
// ============================================================

// 网络策略快照序列化（落库展示 / MCP·OpenAPI 归属字段）
function netPolicyJson(
  policy: NetworkPolicy,
  domain?: DomainPolicy | null,
  endpoint?: import("@/lib/endpoint-policy").EndpointPolicy | null,
  file?: import("@/lib/file-policy").FilePolicy | null,
): Prisma.InputJsonValue {
  const snapshot: Record<string, unknown> = JSON.parse(JSON.stringify(policy))
  if (domain) {
    snapshot.domainMode = domain.mode
    snapshot.domainBlack = domain.blackPatterns
    snapshot.domainWhite = domain.whitePatterns
  }
  if (endpoint) {
    snapshot.endpointBlack = endpoint.blackPatterns
    snapshot.endpointWhite = endpoint.whitePatterns
  }
  if (file) {
    snapshot.fileAllowDownload = file.allowDownload
    snapshot.fileAllowUpload = file.allowUpload
    snapshot.fileAllowFileScheme = file.allowFileScheme
    snapshot.fileSource = file.source
  }
  return snapshot as Prisma.InputJsonValue
}

// 组装代理URL：internal_singbox 类型读取实例内网socks地址
async function buildProxyUrl(proxyNodeId?: string | null): Promise<{ proxyUrl?: string; proxyNodeName?: string; singboxInstanceId?: string | null }> {
  if (!proxyNodeId) return {}
  const node = await db.proxyNode.findFirst({ where: { id: proxyNodeId, deletedAt: null } })
  if (!node) throw new Error("代理节点不存在或已删除")
  if (node.status === "FAILED" || node.status === "DISABLED") throw new Error(`代理节点当前不可用（${node.status}）`)
  if (node.type === "internal_singbox") {
    const inst = node.singboxInstanceId ? await db.singboxInstance.findFirst({ where: { id: node.singboxInstanceId, deletedAt: null } }) : null
    if (!inst || !inst.socksAddr || inst.status !== "RUNNING") throw new Error("关联的 SingBox 实例未运行")
    if (inst.maxSessions > 0 && inst.currentSessions >= inst.maxSessions) throw new Error("该 SingBox 实例会话数已达上限")
    return { proxyUrl: `socks5://${inst.socksAddr}`, proxyNodeName: node.name, singboxInstanceId: inst.id }
  }
  const auth = node.username && node.password ? `${encodeURIComponent(node.username)}:${encodeURIComponent(decrypt(node.password))}@` : ""
  return {
    proxyUrl: `${node.protocol === "http" ? "http" : "socks5"}://${auth}${node.host}:${node.port}`,
    proxyNodeName: node.name,
    singboxInstanceId: null,
  }
}

// 校验用户组可用该代理节点（组绑定）
async function checkProxyAccess(userId: string, proxyNodeId: string) {
  const gids = await userGroupIds(userId)
  const bindings = await db.groupProxy.findMany({ where: { proxyNodeId, groupId: { in: gids } } })
  const isAdmin = (await db.user.findUnique({ where: { id: userId } }))?.role
  if (bindings.length === 0 && isAdmin !== "SUPER_ADMIN" && isAdmin !== "ADMIN") {
    throw new Error("您所属的用户组未分配该代理节点")
  }
}

// Steel 节点调度：负载感知 + 标签 + 灰度分组隔离
async function pickSteelNode(labels?: string[]): Promise<string | null> {
  const nodes = await db.steelNode.findMany({
    where: { enabled: true, deletedAt: null, status: "ONLINE", grayGroup: "PROD" },
    orderBy: { loadScore: "asc" },
  })
  if (nodes.length === 0) return null
  if (labels && labels.length > 0) {
    const matched = nodes.find((n) => (n.labels as string[])?.some((l) => labels.includes(l)))
    if (matched) return matched.id
  }
  return nodes[0].id
}

const createSchema = z.object({
  name: z.string().min(1, "名称必填").max(64),
  mode: z.enum(["cdp_light", "novnc_full"]),
  templateId: z.string().optional().nullable(),
  proxyNodeId: z.string().optional().nullable(),
  profileSnapshotId: z.string().optional().nullable(),
  ttlMinutes: zPrecision("TTL", 0, 525600).optional().default(0),
  idleTimeoutMinutes: zPrecision("闲置超时", 1, 1440).optional().default(60),
  resolution: z.string().optional().default("1920x1080"),
  tags: z.string().optional().default(""),
})

// ---- 创建工作区（幂等 + 配额 + 预留水位 + 风控 + 行为画像）----
export async function createWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; uuid: string; cdpUrl?: string | null; mode: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requireWritableMode()
    await requirePermission(ctx.userId, "blockCreateWorkspace", "管理员已禁止您创建浏览器工作区")
    const p = zodValidate(createSchema, input)

    // 幂等防重复提交
    const idem = await idempotencyCheck(ctx.userId, "create_workspace", { name: p.name, mode: p.mode }, 8000)
    if (idem.repeated) throw new Error("请勿重复提交，工作区正在创建中")

    // 速率限制（防短时间大量创建）
    const createLimit = await getConfigNumber("workspace.createRateLimitPerMin", 10)
    if (!rateLimit(`wscreate:${ctx.userId}`, createLimit, 60_000).allowed) {
      await trackBehavior(ctx.userId, "RISK")
      throw new Error("创建过于频繁，请稍后再试")
    }

    // 行为风控：高频创建检测
    const abnormal = await detectAbnormalBehavior(ctx.userId, "WORKSPACE_CREATE")
    if (abnormal.abnormal) throw new Error("检测到异常高频创建行为，已触发风控拦截")

    // 配额三级校验（含预留水位）
    const quota = await checkSessionQuota(ctx.userId, p.mode === "cdp_light" ? "sessions" : "novncSessions")
    if (!quota.ok) throw new Error(quota.reason || "配额不足")

    // 代理节点权限校验
    if (p.proxyNodeId) await checkProxyAccess(ctx.userId, p.proxyNodeId)

    // 模板加载（继承配置）
    let templateConfig: Record<string, unknown> = {}
    if (p.templateId) {
      const tpl = await db.browserTemplate.findFirst({ where: { id: p.templateId, deletedAt: null } })
      if (tpl) {
        const gids = await userGroupIds(ctx.userId)
        const visible = tpl.scope === "GLOBAL" || (tpl.scope === "GROUP" && tpl.groupId && gids.includes(tpl.groupId)) || tpl.userId === ctx.userId
        if (!visible && ctx.role === "USER") throw new Error("无权使用该模板")
        templateConfig = JSON.parse(tpl.configJson || "{}")
        if (tpl.parentId) {
          const parent = await db.browserTemplate.findFirst({ where: { id: tpl.parentId, deletedAt: null } })
          if (parent) templateConfig = { ...JSON.parse(parent.configJson || "{}"), ...templateConfig } // 子模板覆盖部分参数
        }
      }
    }

    const tags = p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : []

    if (p.mode === "cdp_light") {
      // ---- CDP 轻量会话 ----
      const proxyInfo = await buildProxyUrl(p.proxyNodeId)
      const steelNodeId = await pickSteelNode()
      // 生效网络访问策略快照（Steel 外部集群形态：策略随规格下发并落库；自托管形态由容器层执行）
      const { network: netPolicy, domain: domPolicy, endpoint: endPolicy, file: filePolicy } = await resolveAccessPolicies(ctx.userId)
      const session = await createSession({
        proxyUrl: proxyInfo.proxyUrl,
        userAgent: (templateConfig.ua as string) || undefined,
        timezone: (templateConfig.timezone as string) || undefined,
        locale: (templateConfig.locale as string) || undefined,
        ttlMinutes: p.ttlMinutes || undefined,
        profileMount: p.profileSnapshotId ? `snapshots/${p.profileSnapshotId}` : undefined,
      })
      const ws = await db.browserWorkspace.create({
        data: {
          name: p.name,
          mode: "cdp_light",
          status: "RUNNING",
          startedAt: new Date(),
          lastActiveAt: new Date(),
          userId: ctx.userId,
          groupId: (await userGroupIds(ctx.userId))[0] ?? null,
          proxyNodeId: p.proxyNodeId || null,
          singboxInstanceId: proxyInfo.singboxInstanceId || null,
          steelNodeId,
          templateId: p.templateId || null,
          profileSnapshotId: p.profileSnapshotId || null,
          tags,
          steelSessionId: session.sessionId,
          cdpUrl: session.cdpUrl,
          networkPolicyJson: netPolicyJson(netPolicy, domPolicy, endPolicy, filePolicy),
          ttlMinutes: p.ttlMinutes || (await getConfigNumber("workspace.defaultTtlMinutes", 0)),
          idleTimeoutMinutes: p.idleTimeoutMinutes || (await getConfigNumber("workspace.defaultIdleTimeoutMin", 60)),
          createdByUserId: ctx.userId,
        },
      })
      if (p.proxyNodeId) await db.proxyNode.update({ where: { id: p.proxyNodeId }, data: { currentSessions: { increment: 1 } } })
      if (proxyInfo.singboxInstanceId) await db.singboxInstance.update({ where: { id: proxyInfo.singboxInstanceId }, data: { currentSessions: { increment: 1 } } })
      await trackBehavior(ctx.userId, "CREATE")
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_CREATE",
        resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        ownerUserId: ctx.userId, createdByUserId: ctx.userId,
        after: { mode: "cdp_light", steelSessionId: session.sessionId, proxy: proxyInfo.proxyNodeName, simulated: session.simulated },
      })
      return { id: ws.id, uuid: ws.uuid, cdpUrl: session.cdpUrl, mode: "cdp_light" }
    } else {
      // ---- NoVNC 重度会话（独立配额校验在上面已做）----
      const proxyInfo = await buildProxyUrl(p.proxyNodeId)
      // 生效网络访问策略（管理员按用户/组控制：内网 / 容器安全位置）——创建时快照落库
      const { network: netPolicy, domain: domPolicy, endpoint: endPolicy, file: filePolicy } = await resolveAccessPolicies(ctx.userId)
      // 隔离Profile键：绑定“用户对应的配置的浏览器”，闪退/重建后自动还原同一环境
      const profileKey = p.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      const novnc = await createNovncSession({
        proxyUrl: proxyInfo.proxyUrl,
        resolution: p.resolution,
        ttlMinutes: p.ttlMinutes || undefined,
        profileMount: p.profileSnapshotId ? `snapshots/${p.profileSnapshotId}` : undefined,
        userId: ctx.userId,
        profileKey,
        cpuLimit: (templateConfig.cpuLimit as number) || undefined,
        memLimitMb: (templateConfig.memLimitMb as number) || undefined,
        startUrl: (templateConfig.startUrl as string) || undefined,
        labels: { "dockyard.owner": ctx.userId, "dockyard.profile-key": profileKey },
        networkPolicy: netPolicy,
        domainPolicy: domPolicy,
        endpointPolicy: endPolicy,
        filePolicy,
      })
      const hardening = novnc.hardening || browserHardeningSummary({
        image: ENV.browserImage, cpuLimit: (templateConfig.cpuLimit as number) || 1, memLimitMb: (templateConfig.memLimitMb as number) || 1024,
        pidsLimit: 256, network: "dockyard-sessions", profileDir: null, networkPolicy: { allowInternalNetwork: netPolicy.allowInternalNetwork, allowSecureLocationAccess: netPolicy.allowSecureLocationAccess },
      })
      const hardeningSnapshot = { ...hardening, profileKey, provisioned: novnc.simulated ? "simulated" : "live" } as BrowserHardeningInfo & { profileKey: string; provisioned: string }
      const hardeningJsonInput = JSON.parse(JSON.stringify(hardeningSnapshot)) as Prisma.InputJsonValue
      const ws = await db.browserWorkspace.create({
        data: {
          name: p.name,
          mode: "novnc_full",
          status: "RUNNING",
          startedAt: new Date(),
          lastActiveAt: new Date(),
          userId: ctx.userId,
          groupId: (await userGroupIds(ctx.userId))[0] ?? null,
          proxyNodeId: p.proxyNodeId || null,
          singboxInstanceId: proxyInfo.singboxInstanceId || null,
          templateId: p.templateId || null,
          profileSnapshotId: p.profileSnapshotId || null,
          tags,
          novncSessionId: novnc.novncSessionId,
          novncSecret: encrypt(novnc.secret),
          novncConnCount: 1,
          cdpUrl: novnc.cdpUrl || null, // 内嵌形态：真实 CDP 端点（http://127.0.0.1:<port>/json）
          containerRef: novnc.containerName || null,
          hardeningJson: hardeningJsonInput,
          networkPolicyJson: netPolicyJson(netPolicy, domPolicy, endPolicy, filePolicy),
          ttlMinutes: p.ttlMinutes,
          idleTimeoutMinutes: p.idleTimeoutMinutes,
          createdByUserId: ctx.userId,
        },
      })
      if (p.proxyNodeId) await db.proxyNode.update({ where: { id: p.proxyNodeId }, data: { currentSessions: { increment: 1 } } })
      if (proxyInfo.singboxInstanceId) await db.singboxInstance.update({ where: { id: proxyInfo.singboxInstanceId }, data: { currentSessions: { increment: 1 } } })
      await trackBehavior(ctx.userId, "CREATE")
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_CREATE",
        resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        ownerUserId: ctx.userId, createdByUserId: ctx.userId,
        after: { mode: "novnc_full", novncSessionId: novnc.novncSessionId, resolution: p.resolution },
      })
      return { id: ws.id, uuid: ws.uuid, mode: "novnc_full" }
    }
  })
}

// ---- 停止工作区（销毁底层会话，记录保留）----
export async function stopWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.userId !== ws.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作该工作区")

    if (ws.mode === "cdp_light" && ws.steelSessionId) await destroySession(ws.steelSessionId).catch(() => {})
    if (ws.mode === "novnc_full" && ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
    if (ws.proxyNodeId) await db.proxyNode.update({ where: { id: ws.proxyNodeId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})
    if (ws.singboxInstanceId) await db.singboxInstance.update({ where: { id: ws.singboxInstanceId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})

    const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
    await db.browserWorkspace.update({ where: { id }, data: { status: "STOPPED", steelSessionId: null, cdpUrl: null, novncSessionId: null, startedAt: null, runtimeAccumSec: { increment: runtimeDelta } } })
    await trackBehavior(ctx.userId, "DELETE")
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_STOP",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      before: { status: ws.status }, after: { status: "STOPPED" },
    })
    return null
  })
}

// ---- 重新启动工作区（复用原配置）----
export async function startWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requireWritableMode()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.userId !== ws.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作该工作区")
    if (ws.status === "RUNNING") throw new Error("工作区已在运行中")

    const proxyInfo = await buildProxyUrl(ws.proxyNodeId)
    if (ws.mode === "cdp_light") {
      const session = await createSession({
        proxyUrl: proxyInfo.proxyUrl,
        ttlMinutes: ws.ttlMinutes || undefined,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
      })
      await db.browserWorkspace.update({ where: { id }, data: { status: "RUNNING", steelSessionId: session.sessionId, cdpUrl: session.cdpUrl, steelNodeId: await pickSteelNode(), startedAt: new Date() } })
    } else {
      const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
      const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      // 重建时重新解析生效策略（管理员收紧/放宽即时作用于新容器；四层解析含单沙箱级）
      const { network: netPolicy, domain: domPolicy, endpoint: endPolicy, file: filePolicy } = await resolveAccessPolicies(ws.userId, ws.id)
      const novnc = await createNovncSession({
        proxyUrl: proxyInfo.proxyUrl,
        ttlMinutes: ws.ttlMinutes || undefined,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
        userId: ws.userId,
        profileKey,
        workspaceId: ws.id, // CRX/网络/域名/端点/文件策略按沙箱级解析注入
        labels: { "dockyard.owner": ws.userId, "dockyard.profile-key": profileKey },
        networkPolicy: netPolicy,
        domainPolicy: domPolicy,
        endpointPolicy: endPolicy,
        filePolicy,
      })
      await db.browserWorkspace.update({
        where: { id },
        data: {
          status: "RUNNING", novncSessionId: novnc.novncSessionId, novncSecret: encrypt(novnc.secret),
          cdpUrl: novnc.cdpUrl || null,
          startedAt: new Date(),
          containerRef: novnc.containerName || null,
          hardeningJson: JSON.parse(JSON.stringify(novnc.hardening ? { ...novnc.hardening, profileKey, provisioned: "live" } : (prevHardening || {}))) as Prisma.InputJsonValue,
          networkPolicyJson: netPolicyJson(netPolicy, domPolicy, endPolicy, filePolicy),
        },
      })
    }
    if (ws.proxyNodeId) await db.proxyNode.update({ where: { id: ws.proxyNodeId }, data: { currentSessions: { increment: 1 } } }).catch(() => {})
    if (ws.singboxInstanceId) await db.singboxInstance.update({ where: { id: ws.singboxInstanceId }, data: { currentSessions: { increment: 1 } } }).catch(() => {})
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_START",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      before: { status: ws.status }, after: { status: "RUNNING" },
    })
    return null
  })
}

// ---- 删除工作区（软删除入回收站）----
export async function deleteWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id, reason } = zodValidate(z.object({ id: z.string(), reason: z.string().optional().default("") }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.userId !== ws.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作该工作区")

    if (ws.status === "RUNNING" || ws.status === "CREATING") {
      if (ws.mode === "cdp_light" && ws.steelSessionId) await destroySession(ws.steelSessionId).catch(() => {})
      if (ws.mode === "novnc_full" && ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
    }
    if (ws.proxyNodeId) await db.proxyNode.update({ where: { id: ws.proxyNodeId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})
    if (ws.singboxInstanceId) await db.singboxInstance.update({ where: { id: ws.singboxInstanceId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})

    await db.browserWorkspace.update({ where: { id }, data: { deletedAt: new Date(), status: "DESTROYED" } })
    await moveToRecycle({
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      deletedByUserId: ctx.userId, deletedByType: "USER", reason: reason || undefined,
    })
    await trackBehavior(ctx.userId, "DELETE")
    return null
  })
}

// ---- 切换代理节点（保留profile快照，销毁旧会话重建）----
export async function switchProxyAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockSwitchProxyNode", "管理员已禁止切换代理节点")
    const { id, proxyNodeId } = zodValidate(z.object({ id: z.string(), proxyNodeId: z.string().nullable() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ctx.userId !== ws.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作该工作区")
    if (proxyNodeId) await checkProxyAccess(ctx.userId, proxyNodeId)

    const proxyInfo = await buildProxyUrl(proxyNodeId)
    // Chrome不支持热切代理：销毁旧会话 → 保留profile快照 → 新代理重建
    if (ws.mode === "cdp_light") {
      if (ws.steelSessionId) await destroySession(ws.steelSessionId).catch(() => {})
      const session = await createSession({
        proxyUrl: proxyInfo.proxyUrl,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
        ttlMinutes: ws.ttlMinutes || undefined,
      })
      await db.browserWorkspace.update({
        where: { id },
        data: { steelSessionId: session.sessionId, cdpUrl: session.cdpUrl, proxyNodeId: proxyNodeId || null, singboxInstanceId: proxyInfo.singboxInstanceId || null, status: "RUNNING", startedAt: new Date() },
      })
    } else {
      if (ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
      const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
      const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      const switchedPolicy = await resolveNetworkPolicy(ws.userId, ws.id)
      const [switchedDomain, switchedEndpoint, switchedFile] = await Promise.all([
        resolveDomainPolicyForUser(ws.userId, ws.id),
        resolveEndpointPolicyForUser(ws.userId, ws.id),
        import("@/lib/file-policy").then((m) => m.resolveFilePolicy(ws.userId, ws.id)),
      ])
      const novnc = await createNovncSession({
        proxyUrl: proxyInfo.proxyUrl,
        ttlMinutes: ws.ttlMinutes || undefined,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
        userId: ws.userId,
        profileKey,
        workspaceId: ws.id, // CRX 五级策略按沙箱解析注入
        labels: { "dockyard.owner": ws.userId, "dockyard.profile-key": profileKey },
        // 代理切换重建：策略重新解析，新代理地址同步锁入托管策略
        networkPolicy: switchedPolicy,
        domainPolicy: switchedDomain,
        endpointPolicy: switchedEndpoint,
        filePolicy: switchedFile,
      })
      await db.browserWorkspace.update({
        where: { id },
        data: {
          novncSessionId: novnc.novncSessionId, novncSecret: encrypt(novnc.secret),
          cdpUrl: novnc.cdpUrl || null,
          containerRef: novnc.containerName || null,
          hardeningJson: JSON.parse(JSON.stringify(novnc.hardening ? { ...novnc.hardening, profileKey, provisioned: "live" } : (prevHardening || {}))) as Prisma.InputJsonValue,
          networkPolicyJson: netPolicyJson(switchedPolicy, switchedDomain, switchedEndpoint, switchedFile),
          startedAt: new Date(),
          proxyNodeId: proxyNodeId || null, singboxInstanceId: proxyInfo.singboxInstanceId || null, status: "RUNNING",
        },
      })
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SWITCH_PROXY",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      before: { proxyNodeId: ws.proxyNodeId }, after: { proxyNodeId, proxy: proxyInfo.proxyNodeName },
      severity: "WARN",
    })
    return { restarted: true }
  })
}

// ---- 会话共享授权 ----
export async function shareWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockShareWorkspace", "管理员已禁止分享工作区")
    const { workspaceId, targetUsername, permission, expireHours } = zodValidate(
      z.object({
        workspaceId: z.string(),
        targetUsername: z.string().min(1),
        permission: z.enum(["VIEW", "OPERATE"]),
        expireHours: zPrecision("共享时长", 0, 8760).optional().default(0),
      }),
      input
    )
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN") throw new Error("只有所有者可以共享工作区")
    const target = await db.user.findFirst({ where: { username: targetUsername, deletedAt: null } })
    if (!target) throw new Error("目标用户不存在")
    if (target.id === ws.userId) throw new Error("不能共享给自己")

    await db.workspaceShare.upsert({
      where: { workspaceId_targetUserId: { workspaceId, targetUserId: target.id } },
      update: { permission, expireAt: expireHours > 0 ? new Date(Date.now() + expireHours * 3600_000) : null, revokedAt: null },
      create: {
        workspaceId, targetUserId: target.id, permission,
        expireAt: expireHours > 0 ? new Date(Date.now() + expireHours * 3600_000) : null,
        createdByUserId: ctx.userId,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE",
      resourceType: "WORKSPACE", resourceId: workspaceId, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      after: { targetUser: target.username, permission, expireHours },
    })
    return null
  })
}

export async function revokeShareAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { shareId } = zodValidate(z.object({ shareId: z.string() }), input)
    const share = await db.workspaceShare.findUnique({ where: { id: shareId } })
    if (!share) throw new Error("共享记录不存在")
    const ws = await db.browserWorkspace.findUnique({ where: { id: share.workspaceId } })
    if (ws && ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    await db.workspaceShare.update({ where: { id: shareId }, data: { revokedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE_REVOKE",
      resourceType: "WORKSPACE", resourceId: share.workspaceId,
      after: { revokedShareId: shareId },
    })
    return null
  })
}

// ---- 导出工作区配置JSON（重建会话用）----
export async function exportWorkspaceConfigAction(input: unknown): Promise<ActionResult<{ config: Record<string, unknown> }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockExportData", "管理员已禁止导出")
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    const gids = await userGroupIds(ctx.userId)
    const isShared = await db.workspaceShare.findFirst({ where: { workspaceId: id, targetUserId: ctx.userId, revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] } })
    if (ws.userId !== ctx.userId && !isShared && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权导出该工作区")
    const proxy = ws.proxyNodeId ? await db.proxyNode.findUnique({ where: { id: ws.proxyNodeId } }) : null
    const config = {
      name: ws.name, mode: ws.mode, proxy: proxy ? { name: proxy.name, type: proxy.type } : null,
      templateId: ws.templateId, profileSnapshotId: ws.profileSnapshotId,
      ttlMinutes: ws.ttlMinutes, idleTimeoutMinutes: ws.idleTimeoutMinutes, tags: ws.tags,
      exportedAt: new Date().toISOString(), uuid: ws.uuid,
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_EXPORT_CONFIG",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
    })
    return { config }
  })
}

// ---- 生成HAR（网络记录导出）----
export async function exportHarAction(input: unknown): Promise<ActionResult<{ harAvailable: boolean; recordId?: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    const existing = await db.harRecord.findFirst({ where: { workspaceId: id, deletedAt: null }, orderBy: { createdAt: "desc" } })
    if (existing) {
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "HAR_EXPORT",
        resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      })
      return { harAvailable: true, recordId: existing.id }
    }
    // 无持久化HAR时：创建记录（演示环境无真实CDP流量；生产由网关CDP事件缓存填充）
    const harJson = JSON.stringify({
      log: {
        version: "1.2",
        creator: { name: "Dockyard Gateway", version: "1.0" },
        entries: [],
        _workspace: { id: ws.id, uuid: ws.uuid, mode: ws.mode },
        _generatedAt: new Date().toISOString(),
      },
    })
    const rec = await db.harRecord.create({ data: { workspaceId: id, userId: ctx.userId, harJson, sizeBytes: harJson.length } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "HAR_EXPORT",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
    })
    return { harAvailable: true, recordId: rec.id }
  })
}

// ---- 修改工作区配置（TTL/闲置超时/名称/标签）----
export async function updateWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockModifyWorkspace", "管理员已禁止修改工作区配置")
    const { id, name, ttlMinutes, idleTimeoutMinutes, tags } = zodValidate(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(64).optional(),
        ttlMinutes: zPrecision("TTL", 0, 525600).optional(),
        idleTimeoutMinutes: zPrecision("闲置超时", 1, 1440).optional(),
        tags: z.string().optional(),
      }),
      input
    )
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    await db.browserWorkspace.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
        ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
        ...(tags !== undefined ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_UPDATE",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      before: { name: ws.name, ttl: ws.ttlMinutes, idle: ws.idleTimeoutMinutes },
      after: { name, ttlMinutes, idleTimeoutMinutes, tags },
    })
    return null
  })
}

// ---- 执行脚本注入（脚本模板绑定会话执行）----
export async function runScriptAction(input: unknown): Promise<ActionResult<{ runLogId: string; status: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId, scriptId } = zodValidate(z.object({ workspaceId: z.string(), scriptId: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws || (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN")) throw new Error("无权操作该工作区")
    if (ws.mode !== "cdp_light") throw new Error("仅 CDP 轻量会话支持脚本注入")
    if (ws.status !== "RUNNING") throw new Error("工作区未在运行中")
    const script = await db.browserScriptTemplate.findFirst({ where: { id: scriptId, deletedAt: null } })
    if (!script) throw new Error("脚本不存在")
    if (ctx.userId !== script.userId && script.scope === "PRIVATE") throw new Error("无权使用该私有脚本")

    // 沙箱约束：高危模式拦截
    const code = script.code
    const forbidden = [/eval\s*\(/, /Function\s*\(/, /require\s*\(/, /process\./, /import\s*\(/]
    const hit = forbidden.find((re) => re.test(code))
    const log = await db.browserScriptRunLog.create({
      data: { scriptId, workspaceId, status: hit ? "BLOCKED" : "SUCCESS", log: hit ? `脚本命中高危模式 ${hit} 被沙箱拦截` : `脚本经网关下发至 Steel 会话执行（${ws.steelSessionId}），绑定域名：${JSON.stringify(script.boundDomains)}`, finishedAt: new Date() },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "SCRIPT_RUN",
      resourceType: "WORKSPACE", resourceId: workspaceId, resourceName: ws.name,
      after: { scriptId, status: hit ? "BLOCKED" : "SUCCESS" },
    })
    return { runLogId: log.id, status: log.status }
  })
}

// ---- 刷新VNC临时密钥 ----
export async function refreshVncKeyAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockRefreshVncKey", "管理员已禁止刷新VNC密钥")
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws || ws.mode !== "novnc_full") throw new Error("NoVNC会话不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    if (!ws.novncSessionId) throw new Error("会话未运行")
    const newSecret = await refreshNovncSecret(ws.novncSessionId)
    if (newSecret) await db.browserWorkspace.update({ where: { id }, data: { novncSecret: encrypt(newSecret) } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "VNC_KEY_REFRESH",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name, severity: "WARN",
    })
    return null
  })
}

// ============================================================
// HelmPort VNC 连接票据：所有者/共享/管理员 → HMAC 票据（60s 单次有效）
// 五重隔离：WorkspaceUUID + 票据HMAC + 只读降级 + 桥侧防重放 + 桥侧只读丢帧
// ============================================================

// 解析当前用户对工作区的 VNC 访问权限（OPERATE=可交互 / VIEW=只读镜像 / null=无权）
async function resolveVncAccess(ctx: { userId: string; role: string }, ws: { id: string; userId: string; groupId: string | null }): Promise<"OPERATE" | "VIEW" | null> {
  if (ws.userId === ctx.userId) return "OPERATE"
  if (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN") return "OPERATE"
  const share = await db.workspaceShare.findFirst({
    where: {
      workspaceId: ws.id, targetUserId: ctx.userId, revokedAt: null,
      OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
    },
  })
  if (share) return share.permission === "OPERATE" ? "OPERATE" : "VIEW"
  if (ctx.role === "GROUP_ADMIN" && ws.groupId) {
    const gids = await userGroupIds(ctx.userId)
    if (gids.includes(ws.groupId)) return "OPERATE"
  }
  return null
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ---- 签发 VNC 连接票据（HelmPort 客户端凭票据直连网关桥）----
export async function getVncTicketAction(input: unknown): Promise<ActionResult<{
  ticket: string
  wsUrlQuery: string
  bridge: { mode: string; port: number; url: string }
  readonly: boolean
  expiresInSec: number
  sessionMaxSec: number
  limitSource: string
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: z.string() }), input)

    // 速率限制：防票据接口刷量
    if (!rateLimit(`vncTicket:${ctx.userId}`, 30, 60_000).allowed) throw new Error("取票过于频繁，请稍后再试")

    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws || ws.mode !== "novnc_full") throw new Error("NoVNC 会话不存在")
    if (!ws.novncSessionId) throw new Error("会话未运行")
    if (ws.status !== "RUNNING" && ws.status !== "IDLE") throw new Error(`会话当前不可连接（${ws.status}）`)

    const access = await resolveVncAccess(ctx, ws)
    if (!access) throw new Error("您无权访问该远程桌面")

    // 全局开关：只读观察模式（管理员可强制全员只读）
    const globalViewOnly = await getConfigBool("session.vncGlobalViewOnly", false)
    const readonly = access === "VIEW" || globalViewOnly

    // 解析拨号目标（真实容器IP / 池RFB端点 / 演示引擎）
    const tgt = await novncDialTarget(ws.novncSessionId, ws.containerRef)
    if (!tgt) throw new Error("远程桌面通道暂不可用，请稍后重试或联系管理员")

    // ---- VNC 会话时长上限（三级策略：沙箱 > 用户 > 用户组 > 全局默认；null=继承，0/缺省=不限）----
    // 语义说明：票据 60s 时效 = 取票→建连窗口（单次防重放）；本字段 = 连接总时长上限（默认不限）
    const owner = await db.user.findUnique({ where: { id: ws.userId }, select: { vncSessionMaxMinutes: true } })
    let ownerGroupId: string | null = ws.groupId
    if (!ownerGroupId) {
      const gu = await db.groupUser.findFirst({ where: { userId: ws.userId }, orderBy: { createdAt: "desc" }, select: { groupId: true } })
      ownerGroupId = gu?.groupId ?? null
    }
    const ownerGroup = ownerGroupId ? await db.group.findUnique({ where: { id: ownerGroupId }, select: { vncSessionMaxMinutes: true } }) : null
    const globalMaxMinutes = await getConfigNumber("vnc.sessionMaxMinutes", 0)
    let sessionMaxSec = 0
    let limitSource = "无限制（默认）"
    if (ws.vncSessionMaxMinutes != null) {
      sessionMaxSec = ws.vncSessionMaxMinutes > 0 ? ws.vncSessionMaxMinutes * 60 : 0
      limitSource = ws.vncSessionMaxMinutes > 0 ? "沙箱策略" : "沙箱策略（显式不限）"
    } else if (owner?.vncSessionMaxMinutes != null) {
      sessionMaxSec = owner.vncSessionMaxMinutes > 0 ? owner.vncSessionMaxMinutes * 60 : 0
      limitSource = owner.vncSessionMaxMinutes > 0 ? "用户策略" : "用户策略（显式不限）"
    } else if (ownerGroup?.vncSessionMaxMinutes != null) {
      sessionMaxSec = ownerGroup.vncSessionMaxMinutes > 0 ? ownerGroup.vncSessionMaxMinutes * 60 : 0
      limitSource = ownerGroup.vncSessionMaxMinutes > 0 ? "用户组策略" : "用户组策略（显式不限）"
    } else if (globalMaxMinutes > 0) {
      sessionMaxSec = globalMaxMinutes * 60
      limitSource = "全局默认"
    }

    const expSec = 60
    const payload = { v: ws.id, ro: readonly ? 1 : 0, dur: sessionMaxSec, exp: Math.floor(Date.now() / 1000) + expSec, n: crypto.randomBytes(16).toString("hex"), tgt }
    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"))
    const sig = b64url(crypto.createHmac("sha256", ENV.vncBridgeSecret).update(payloadB64).digest())
    const ticket = `${payloadB64}.${sig}`

    await trackBehavior(ctx.userId, "LOGIN") // 轻量活跃度记录
    await db.browserWorkspace.update({ where: { id: ws.id }, data: { lastActiveAt: new Date() } }).catch(() => {})
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "VNC_TICKET_ISSUE",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { access, readonly, target: tgt.k, sessionMaxSec, limitSource },
    })
    return {
      ticket,
      wsUrlQuery: `vnc=${encodeURIComponent(ws.id)}&ticket=${encodeURIComponent(ticket)}`,
      bridge: { mode: ENV.vncBridgePublic, port: ENV.vncBridgePort, url: ENV.vncBridgeUrl },
      readonly,
      expiresInSec: expSec,
      sessionMaxSec,
      limitSource,
    }
  })
}

// ---- 防退出运维：容器内浏览器进程级重启（同一Profile 1 秒内拉起）----
// 用户浏览器卡死时的自救按钮；管理员对任意用户会话同样可执行（见 admin-workspaces 强制重启）
export async function restartBrowserProcessAction(input: unknown): Promise<ActionResult<{ restarted: boolean; simulated: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws || ws.mode !== "novnc_full") throw new Error("NoVNC 会话不存在")
    if (ws.status !== "RUNNING" && ws.status !== "IDLE") throw new Error("会话未在运行中")

    const access = await resolveVncAccess(ctx, ws)
    if (access !== "OPERATE") throw new Error("仅所有者或管理员可重启浏览器进程")

    // 限速：同一会话 30 秒内仅允许一次进程重启
    if (!rateLimit(`vncRestart:${ws.id}`, 1, 30_000).allowed) throw new Error("操作过于频繁，请等待 30 秒后重试")

    let result: { restarted: boolean; simulated: boolean }
    if (ws.containerRef) {
      // 自托管：向 supervisor 发 USR1 → 杀浏览器子进程 → 主循环同一 Profile 立即拉起
      result = await restartBrowserProcessInContainer(ws.containerRef)
    } else if (ws.novncSessionId) {
      // 池集群：委托池侧重启；模拟模式同样走适配器
      const r = await restartNovncBrowser(ws.novncSessionId, ws.containerRef)
      result = { restarted: r.restarted, simulated: !ws.containerRef && !(await import("@/lib/env")).externalAvailable.novnc && !(await import("@/lib/env")).externalAvailable.docker }
    } else {
      throw new Error("会话通道不存在")
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "BROWSER_PROCESS_RESTART",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      after: { containerRef: ws.containerRef, simulated: result.simulated }, severity: "WARN",
    })
    return result
  })
}
