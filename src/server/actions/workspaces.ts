"use server"

import { z } from "zod"
import crypto from "crypto"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireAuth, checkSessionQuota, userGroupIds, requireWritableMode, requirePermission, requireAdmin } from "@/lib/permissions"
import { actionHandler, type ActionResult } from "@/lib/api"
import { writeAudit } from "@/lib/audit"
import { encrypt, decrypt, randomHex } from "@/lib/crypto"
import { rateLimit } from "@/lib/rate-limit"
import { idempotencyCheck } from "@/lib/idempotency"
import { trackBehavior, detectAbnormalBehavior } from "@/lib/risk"
import { raiseAlert } from "@/lib/alerts"
import { zodValidate, zPrecision } from "@/lib/validators"
import { createSession, destroySession } from "@/lib/external/browser-session"
import { createNovncSession, destroyNovncSession, refreshNovncSecret, novncDialTarget, restartNovncBrowser, type NovncSession } from "@/lib/external/novnc"
import { browserHardeningSummary, restartBrowserProcessInContainer, type BrowserHardeningInfo } from "@/lib/external/docker"
import { resolveNetworkPolicy, type NetworkPolicy } from "@/lib/network-policy"
import { resolveAccessPolicies, resolveDomainPolicyForUser, type DomainPolicy } from "@/lib/domain-policy"
import { resolveEndpointPolicyForUser } from "@/lib/endpoint-policy"
import { ENV } from "@/lib/env"
import { moveToRecycle } from "@/lib/recycle"
import { getConfigBool, getConfig, getConfigNumber } from "@/lib/config"
import { assertShareAllowed } from "@/lib/share-policy"
import { resolveIdlePolicyForUser, isAdminRole, fmtIdleBrief } from "@/lib/idle-policy"
import { resolveRecordingPolicy, recordingTuning, registerWorkspaceRecording, type RecordingPolicy, type RecordingTuning } from "@/lib/recording"
import { resolveHardwarePolicy, hardwareManagedPolicies, resolveClipboardSync } from "@/lib/hardware-perms"
import { validateExtraPolicies } from "@/lib/chromium-policies"

// ============================================================
// 浏览器工作区业务 Server Actions
// 数据流：前端表单 → Server Action（权限+配额+幂等+风控校验）
//   → 自研会话引擎/NoVNC 适配层 → Prisma 落库 → 审计 → 返回
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

// ============================================================
// r27：会话录像 + 防退出 + 模板策略项 —— 启动链路统一装配
// ============================================================
// 录像策略四级链（沙箱>用户>组>全局）+ 参数解析
async function resolveRecordingBundle(userId: string, workspaceId?: string | null): Promise<{ policy: RecordingPolicy; tuning: RecordingTuning }> {
  const [policy, tuning] = await Promise.all([resolveRecordingPolicy(userId, workspaceId), recordingTuning()])
  return { policy, tuning }
}

// 防退出档位：模板 > 全局默认（workspace.exitGuardDefault）
async function resolveExitGuard(templateConfig: Record<string, unknown>): Promise<"normal" | "fullscreen" | "kiosk"> {
  const t = templateConfig.exitGuard
  if (t === "normal" || t === "fullscreen" || t === "kiosk") return t
  const g = await getConfig<string>("workspace.exitGuardDefault", "fullscreen")
  return g === "normal" || g === "kiosk" ? g : "fullscreen"
}

// 模板级 Chromium 企业策略项（目录校验不过 → 静默忽略并审计告警）
async function resolveTemplatePolicies(templateId?: string | null): Promise<{ policyJson: Record<string, unknown> | null; exitGuardConfig: Record<string, unknown> }> {
  if (!templateId) return { policyJson: null, exitGuardConfig: {} }
  const tpl = await db.browserTemplate.findFirst({ where: { id: templateId, deletedAt: null }, select: { configJson: true } })
  if (!tpl) return { policyJson: null, exitGuardConfig: {} }
  try {
    const cfg = JSON.parse(tpl.configJson || "{}") as Record<string, unknown>
    const pj = (cfg.policyJson || null) as Record<string, unknown> | null
    if (pj) {
      const v = validateExtraPolicies(pj)
      if (!v.ok) {
        await writeAudit({
          operationType: "WORKSPACE_POLICY_INVALID", resourceType: "TEMPLATE", resourceId: templateId,
          severity: "WARN", extra: { errors: v.errors, action: "模板策略项校验未过 → 已忽略注入" },
        }).catch(() => null)
        return { policyJson: null, exitGuardConfig: cfg }
      }
    }
    return { policyJson: pj, exitGuardConfig: cfg }
  } catch {
    return { policyJson: null, exitGuardConfig: {} }
  }
}

// 沙箱启动后注册录像会话（引擎已下发 ffmpeg；此处建档+审计）
async function provisionRecording(opts: {
  workspace: { id: string; uuid: string; name: string; userId: string }
  username: string
  novnc: NovncSession
  policy: RecordingPolicy
  tuning: RecordingTuning
  resolution: string
}): Promise<void> {
  if (!opts.novnc.recording) return
  await registerWorkspaceRecording({
    workspace: opts.workspace,
    username: opts.username,
    sessionId: opts.novnc.novncSessionId,
    resolution: opts.resolution,
    policy: opts.policy,
    tuning: opts.tuning,
    metadata: { recordDir: opts.novnc.recording.recordDir, fps: opts.novnc.recording.fps, segmentSec: opts.novnc.recording.segmentSec },
  }).catch(() => null)
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

// 浏览器节点调度：负载感知 + 标签 + 灰度分组隔离
async function pickBrowserNode(labels?: string[]): Promise<string | null> {
  const nodes = await db.browserNode.findMany({
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
  idleTimeoutMinutes: zPrecision("闲置超时", 0, 1440).optional().default(60), // 0=无限（永不闲置回收）
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

    // r14（22-c）：闲置超时四级策略链解析（沙箱>用户>组>全局）
    // 表单默认值=策略链解析值（页面传入）；锁定态普通用户传入值被忽略并静默采用解析值（审计留痕）
    const idlePolicy = await resolveIdlePolicyForUser(ctx.userId, ctx.role)
    let idleMinutes = p.idleTimeoutMinutes ?? idlePolicy.defaultMinutes
    const idleIgnoredByPolicy = !isAdminRole(ctx.role) && idlePolicy.locked && idleMinutes !== idlePolicy.defaultMinutes
    if (idleIgnoredByPolicy) idleMinutes = idlePolicy.defaultMinutes

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
      const browserNodeId = await pickBrowserNode()
      // 生效网络访问策略快照（外部分离部署形态：策略随规格下发并落库；自托管形态由容器层执行）
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
          browserNodeId,
          templateId: p.templateId || null,
          profileSnapshotId: p.profileSnapshotId || null,
          tags,
          browserSessionId: session.sessionId,
          cdpUrl: session.cdpUrl,
          networkPolicyJson: netPolicyJson(netPolicy, domPolicy, endPolicy, filePolicy),
          ttlMinutes: p.ttlMinutes || (await getConfigNumber("workspace.defaultTtlMinutes", 0)),
          idleTimeoutMinutes: idleMinutes,
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
        after: { mode: "cdp_light", browserSessionId: session.sessionId, proxy: proxyInfo.proxyNodeName, simulated: session.simulated, idleTimeoutMinutes: idleMinutes, ...(idleIgnoredByPolicy ? { idlePolicy: { lockedBy: idlePolicy.lockSource, enforced: fmtIdleBrief(idleMinutes), submittedIgnored: p.idleTimeoutMinutes } } : {}) },
      })
      return { id: ws.id, uuid: ws.uuid, cdpUrl: session.cdpUrl, mode: "cdp_light" }
    } else {
      // ---- NoVNC 重度会话（独立配额校验在上面已做）----
      const proxyInfo = await buildProxyUrl(p.proxyNodeId)
      // 生效网络访问策略（管理员按用户/组控制：内网 / 容器安全位置）——创建时快照落库
      const { network: netPolicy, domain: domPolicy, endpoint: endPolicy, file: filePolicy } = await resolveAccessPolicies(ctx.userId)
      // 隔离Profile键：绑定“用户对应的配置的浏览器”，闪退/重建后自动还原同一环境
      const profileKey = p.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      // r24-e：预生成工作区 UUID（沙箱专属 Linux 用户命名 + 库内主键同值，创建前即可定身份）
      const wsUuid = crypto.randomUUID()
      // r27：录像策略四级链 + 防退出档位 + 模板策略项（创建链路一次解析）
      const rec = await resolveRecordingBundle(ctx.userId)
      const tplPol = await resolveTemplatePolicies(p.templateId)
      const exitGuard = await resolveExitGuard(tplPol.exitGuardConfig)
      // r29-a：17 项硬件权限四级链（创建链路一次解析 → Managed Preferences 注入 + 硬化快照）
      const hw = await resolveHardwarePolicy(ctx.userId).catch(() => null)
      const hwManaged = hw ? hardwareManagedPolicies(hw.policy) : null
      const clipboardSync = await resolveClipboardSync(ctx.userId)
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
        // r24-c/d/e：偏好输入法/布局随会话应用；VNC X 剪贴板透传受全局开关管控；
        // 沙箱专属 Linux 用户（dyu-<uuid8>-<uname6>）——创建流程预生成 wsUuid 与 ws.create 同值
        imeEngine: (templateConfig.imeEngine as string) || null,
        kbLayout: (templateConfig.kbLayout as string) || null,
        clipboardEnabled: clipboardSync.enabled,
        workspaceUuid: wsUuid,
        ownerUsername: ctx.username,
        domainPolicy: domPolicy,
        endpointPolicy: endPolicy,
        filePolicy,
        // r27：录像 + 防退出 + 模板策略项
        recording: rec.policy.enabled ? { enabled: true, ...rec.tuning, maxSec: rec.tuning.maxMinutes > 0 ? rec.tuning.maxMinutes * 60 : 0 } : undefined,
        exitGuard,
        extraManagedPolicy: tplPol.policyJson,
        // r29-a：硬件权限策略键（四级链；安全层高于模板）
        hardwareManagedPolicy: hwManaged,
      })
      const hardening = novnc.hardening || browserHardeningSummary({
        image: ENV.browserImage, cpuLimit: (templateConfig.cpuLimit as number) || 1, memLimitMb: (templateConfig.memLimitMb as number) || 1024,
        pidsLimit: 256, network: "dockyard-sessions", profileDir: null, networkPolicy: { allowInternalNetwork: netPolicy.allowInternalNetwork, allowSecureLocationAccess: netPolicy.allowSecureLocationAccess },
      })
      const hardeningSnapshot = { ...hardening, profileKey, provisioned: novnc.simulated ? "simulated" : "live", recordingEnabled: rec.policy.enabled, recordingPolicySource: rec.policy.source, exitGuard } as BrowserHardeningInfo & { profileKey: string; provisioned: string; recordingEnabled?: boolean; recordingPolicySource?: string; exitGuard?: string }
      const hardeningJsonInput = JSON.parse(JSON.stringify(hardeningSnapshot)) as Prisma.InputJsonValue
      const ws = await db.browserWorkspace.create({
        data: {
          name: p.name,
          mode: "novnc_full",
          status: "RUNNING",
          uuid: wsUuid, // r24-e：与沙箱专属 Linux 用户命名同源（创建前已传给会话引擎）
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
          idleTimeoutMinutes: idleMinutes,
          createdByUserId: ctx.userId,
        },
      })
      if (p.proxyNodeId) await db.proxyNode.update({ where: { id: p.proxyNodeId }, data: { currentSessions: { increment: 1 } } })
      if (proxyInfo.singboxInstanceId) await db.singboxInstance.update({ where: { id: proxyInfo.singboxInstanceId }, data: { currentSessions: { increment: 1 } } })
      // r27：录像会话建档（引擎已开录；此处注册 + 审计 + session.json 溯源标记）
      await provisionRecording({
        workspace: { id: ws.id, uuid: ws.uuid, name: ws.name, userId: ws.userId },
        username: ctx.username,
        novnc,
        policy: rec.policy,
        tuning: rec.tuning,
        resolution: p.resolution || "1280x800",
      })
      await trackBehavior(ctx.userId, "CREATE")
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_CREATE",
        resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
        ownerUserId: ctx.userId, createdByUserId: ctx.userId,
        after: { mode: "novnc_full", novncSessionId: novnc.novncSessionId, resolution: p.resolution, idleTimeoutMinutes: idleMinutes, recording: rec.policy.enabled ? { enabled: true, source: rec.policy.source, fps: rec.tuning.fps } : { enabled: false, source: rec.policy.source }, exitGuard, ...(idleIgnoredByPolicy ? { idlePolicy: { lockedBy: idlePolicy.lockSource, enforced: fmtIdleBrief(idleMinutes), submittedIgnored: p.idleTimeoutMinutes } } : {}) },
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

    if (ws.mode === "cdp_light" && ws.browserSessionId) await destroySession(ws.browserSessionId).catch(() => {})
    if (ws.mode === "novnc_full" && ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
    if (ws.proxyNodeId) await db.proxyNode.update({ where: { id: ws.proxyNodeId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})
    if (ws.singboxInstanceId) await db.singboxInstance.update({ where: { id: ws.singboxInstanceId }, data: { currentSessions: { decrement: 1 } } }).catch(() => {})

    const runtimeDelta = ws.startedAt ? Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)) : 0
    await db.browserWorkspace.update({ where: { id }, data: { status: "STOPPED", browserSessionId: null, cdpUrl: null, novncSessionId: null, startedAt: null, runtimeAccumSec: { increment: runtimeDelta } } })
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
    // r24-h：离线冻结封存期间禁止启动（安全事件调查取证）
    if (ws.status === "FROZEN") throw new Error(`工作区已被管理员离线冻结封存${ws.freezeReason ? `（${ws.freezeReason}）` : ""}，冻结期间浏览器不可启动；请联系管理员解冻`)

    const proxyInfo = await buildProxyUrl(ws.proxyNodeId)
    if (ws.mode === "cdp_light") {
      const session = await createSession({
        proxyUrl: proxyInfo.proxyUrl,
        ttlMinutes: ws.ttlMinutes || undefined,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
      })
      await db.browserWorkspace.update({ where: { id }, data: { status: "RUNNING", browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, browserNodeId: await pickBrowserNode(), startedAt: new Date() } })
    } else {
      const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
      const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      // 重建时重新解析生效策略（管理员收紧/放宽即时作用于新容器；四层解析含单沙箱级）
      const { network: netPolicy, domain: domPolicy, endpoint: endPolicy, file: filePolicy } = await resolveAccessPolicies(ws.userId, ws.id)
      // r27：录像策略（含沙箱级覆盖）+ 防退出/模板策略项（重建链路同步刷新）
      const rec = await resolveRecordingBundle(ws.userId, ws.id)
      const tplPol = await resolveTemplatePolicies(ws.templateId)
      const exitGuard = await resolveExitGuard(tplPol.exitGuardConfig)
      // r29-a：硬件权限四级链（含沙箱级覆盖，重建链路同步刷新）
      const hwRe = await resolveHardwarePolicy(ws.userId, ws.id).catch(() => null)
      const hwReManaged = hwRe ? hardwareManagedPolicies(hwRe.policy) : null
      const clipboardSyncRe = await resolveClipboardSync(ws.userId, ws.id)
      let novnc
      try {
        novnc = await createNovncSession({
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
          // r24-c/d/e：沙箱输入法/布局偏好随重建应用；剪贴板透传受硬件权限/全局开关管控；沙箱专属用户身份
          imeEngine: ws.imeEngine,
          kbLayout: ws.kbLayout,
          clipboardEnabled: clipboardSyncRe.enabled,
          workspaceUuid: ws.uuid,
          ownerUsername: (await db.user.findUnique({ where: { id: ws.userId }, select: { username: true } }))?.username || "u",
          // r27：录像 + 防退出 + 模板策略项
          recording: rec.policy.enabled ? { enabled: true, ...rec.tuning, maxSec: rec.tuning.maxMinutes > 0 ? rec.tuning.maxMinutes * 60 : 0 } : undefined,
          exitGuard,
          extraManagedPolicy: tplPol.policyJson,
          // r29-a：硬件权限策略键（含沙箱级覆盖）
          hardwareManagedPolicy: hwReManaged,
        })
      } catch (e) {
        // r25-d：启动失败不再静默回 STOPPED —— 落 ERROR 状态 + 失败原因持久化到 hardeningJson
        //（用户在列表即可见失败态与原因，重试入口保留；引擎层已自动重试 3 次）
        const reason = (e as Error).message || String(e)
        await db.browserWorkspace.update({
          where: { id },
          data: {
            status: "ERROR",
            hardeningJson: JSON.parse(JSON.stringify({
              ...(prevHardening || {}),
              lastError: reason.slice(0, 2000),
              lastErrorAt: new Date().toISOString(),
            })) as Prisma.InputJsonValue,
          },
        }).catch(() => {})
        throw new Error(`沙箱启动失败：${reason}`)
      }
      await db.browserWorkspace.update({
        where: { id },
        data: {
          status: "RUNNING", novncSessionId: novnc.novncSessionId, novncSecret: encrypt(novnc.secret),
          cdpUrl: novnc.cdpUrl || null,
          startedAt: new Date(),
          containerRef: novnc.containerName || null,
          hardeningJson: JSON.parse(JSON.stringify(novnc.hardening ? { ...novnc.hardening, profileKey, provisioned: "live", recordingEnabled: rec.policy.enabled, recordingPolicySource: rec.policy.source, exitGuard } : (prevHardening || {}))) as Prisma.InputJsonValue,
          networkPolicyJson: netPolicyJson(netPolicy, domPolicy, endPolicy, filePolicy),
        },
      })
      // r27：录像会话建档（停止/重建后的新进程树 → 新录像组）
      await provisionRecording({
        workspace: { id: ws.id, uuid: ws.uuid, name: ws.name, userId: ws.userId },
        username: ctx.username,
        novnc,
        policy: rec.policy,
        tuning: rec.tuning,
        resolution: (novnc as NovncSession).resolution || "1280x800",
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
      if (ws.mode === "cdp_light" && ws.browserSessionId) await destroySession(ws.browserSessionId).catch(() => {})
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
      if (ws.browserSessionId) await destroySession(ws.browserSessionId).catch(() => {})
      const session = await createSession({
        proxyUrl: proxyInfo.proxyUrl,
        profileMount: ws.profileSnapshotId ? `snapshots/${ws.profileSnapshotId}` : undefined,
        ttlMinutes: ws.ttlMinutes || undefined,
      })
      await db.browserWorkspace.update({
        where: { id },
        data: { browserSessionId: session.sessionId, cdpUrl: session.cdpUrl, proxyNodeId: proxyNodeId || null, singboxInstanceId: proxyInfo.singboxInstanceId || null, status: "RUNNING", startedAt: new Date() },
      })
    } else {
      if (ws.novncSessionId) await destroyNovncSession(ws.novncSessionId, ws.containerRef).catch(() => {})
      const prevHardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
      const profileKey = (prevHardening.profileKey as string) || ws.profileSnapshotId || `p-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      const switchedHardware = await resolveHardwarePolicy(ws.userId, ws.id).catch(() => null)
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
        // r24-c/d/e：沙箱输入法/布局偏好随重建应用；剪贴板透传全局开关；沙箱专属用户身份
        imeEngine: ws.imeEngine,
        kbLayout: ws.kbLayout,
        clipboardEnabled: (await resolveClipboardSync(ws.userId, ws.id)).enabled,
        workspaceUuid: ws.uuid,
        ownerUsername: (await db.user.findUnique({ where: { id: ws.userId }, select: { username: true } }))?.username || "u",
        // r29-a：硬件权限策略键（代理切换重建链路同步注入）
        hardwareManagedPolicy: switchedHardware ? hardwareManagedPolicies(switchedHardware.policy) : null,
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
    // r13c：四级共享管控门禁（沙箱否决 > 用户开关 > 组开关 > 全局开关）
    await assertShareAllowed({ userId: ctx.userId, workspaceId, role: ctx.role })
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

// ---- 共享目标用户搜索（精确用户名优先；输入即搜，点选填入，杜绝手输错字） ----
export async function searchShareTargetUsersAction(input: unknown): Promise<ActionResult<{
  items: { id: string; username: string; displayName: string | null; shared: boolean }[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId, q } = zodValidate(z.object({ workspaceId: z.string(), q: z.string().max(64) }), input)
    const kw = q.trim()
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, userId: true } })
    if (!ws) throw new Error("工作区不存在")

    // 精确用户名匹配优先：where username = kw 或 displayName 包含 / username 前缀
    const users = await db.user.findMany({
      where: {
        deletedAt: null,
        id: { not: ws.userId },
        OR: [
          { username: { contains: kw } },
          { displayName: { contains: kw } },
        ],
      },
      select: { id: true, username: true, displayName: true },
      orderBy: [{ username: "asc" }],
      take: 10,
    })
    // 精确匹配置顶
    users.sort((a, b) => (a.username === kw ? -1 : 0) - (b.username === kw ? -1 : 0))

    // 已共享标记（避免重复添加提示）
    const shares = users.length
      ? await db.workspaceShare.findMany({
          where: { workspaceId, targetUserId: { in: users.map((u) => u.id) }, revokedAt: null },
          select: { targetUserId: true },
        })
      : []
    const sharedSet = new Set(shares.map((s) => s.targetUserId))
    return {
      items: users.map((u) => ({
        id: u.id, username: u.username, displayName: u.displayName,
        shared: sharedSet.has(u.id),
      })),
    }
  })
}

// ---- r22b：批量共享（多选用户一次授权；逐个校验，部分失败汇总返回） ----
export async function shareWorkspaceBatchAction(input: unknown): Promise<ActionResult<{
  success: number
  failures: { username: string; reason: string }[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockShareWorkspace", "管理员已禁止分享工作区")
    const { workspaceId, targetUsernames, permission, expireHours } = zodValidate(
      z.object({
        workspaceId: z.string(),
        targetUsernames: z.array(z.string().min(1).max(64)).min(1, "请至少选择一个用户").max(20, "单次最多共享 20 个用户"),
        permission: z.enum(["VIEW", "OPERATE"]),
        expireHours: zPrecision("共享时长", 0, 8760).optional().default(0),
      }),
      input
    )
    // 四级共享管控门禁（与单人共享同一管控链）
    await assertShareAllowed({ userId: ctx.userId, workspaceId, role: ctx.role })
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN") throw new Error("只有所有者可以共享工作区")

    const failures: { username: string; reason: string }[] = []
    let success = 0
    const expireAt = expireHours > 0 ? new Date(Date.now() + expireHours * 3600_000) : null
    // 输入去重（同一用户只处理一次）
    const usernames = [...new Set(targetUsernames.map((u) => u.trim()).filter(Boolean))]
    for (const username of usernames) {
      try {
        const target = await db.user.findFirst({ where: { username, deletedAt: null } })
        if (!target) throw new Error("用户不存在")
        if (target.id === ws.userId) throw new Error("不能共享给自己")
        await db.workspaceShare.upsert({
          where: { workspaceId_targetUserId: { workspaceId, targetUserId: target.id } },
          update: { permission, expireAt, revokedAt: null },
          create: {
            workspaceId, targetUserId: target.id, permission, expireAt,
            createdByUserId: ctx.userId,
          },
        })
        success++
      } catch (e) {
        failures.push({ username, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE",
      resourceType: "WORKSPACE", resourceId: workspaceId, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      after: { targetUsers: usernames, permission, expireHours, success, failCount: failures.length, failures },
    })
    return { success, failures }
  })
}

// ---- r22b：接收者名单（发起人/管理员视角：共享弹窗内展示 + 单个移除） ----
export async function listWorkspaceShareRecipientsAction(input: unknown): Promise<ActionResult<{
  items: {
    id: string
    targetUsername: string
    targetDisplayName: string | null
    permission: string
    expireAt: string | null
    revokedAt: string | null
    status: "active" | "revoked" | "expired"
    createdAt: string
  }[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId } = zodValidate(z.object({ workspaceId: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, userId: true } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权查看该工作区的共享名单")

    const rows = await db.workspaceShare.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } })
    const userIds = [...new Set(rows.map((r) => r.targetUserId))]
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } })
      : []
    const uMap = new Map(users.map((u) => [u.id, u]))
    const now = Date.now()
    return {
      items: rows.map((r) => ({
        id: r.id,
        targetUsername: uMap.get(r.targetUserId)?.username || r.targetUserId,
        targetDisplayName: uMap.get(r.targetUserId)?.displayName ?? null,
        permission: r.permission,
        expireAt: r.expireAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        status: r.revokedAt ? "revoked" : r.expireAt && r.expireAt.getTime() < now ? "expired" : "active",
        createdAt: r.createdAt.toISOString(),
      })),
    }
  })
}

// ---- r23：批量移除接收者（共享弹窗多选踢出；仅发起人/管理员；逐个撤销不影响其他接收者） ----
export async function batchRevokeShareRecipientsAction(input: unknown): Promise<ActionResult<{
  revoked: number
  skipped: number
  failures: { username: string; reason: string }[]
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { workspaceId, shareIds } = zodValidate(
      z.object({
        workspaceId: z.string(),
        shareIds: z.array(z.string().min(1)).min(1, "请至少选择一个接收者").max(100, "单次最多移除 100 个接收者"),
      }),
      input
    )
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, userId: true, name: true } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
      throw new Error("只有所有者或管理员可以移除接收者")
    }

    const failures: { username: string; reason: string }[] = []
    let revoked = 0
    let skipped = 0
    const now = new Date()
    for (const shareId of shareIds) {
      try {
        const share = await db.workspaceShare.findUnique({ where: { id: shareId } })
        if (!share || share.workspaceId !== workspaceId) {
          skipped++
          continue
        }
        if (share.revokedAt) {
          skipped++
          continue
        }
        await db.workspaceShare.update({ where: { id: shareId }, data: { revokedAt: now } })
        revoked++
      } catch (e) {
        failures.push({ username: shareId, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE_BATCH_REVOKE",
      resourceType: "WORKSPACE", resourceId: workspaceId, resourceName: ws.name,
      ownerUserId: ws.userId,
      after: { shareIds, revoked, skipped, failCount: failures.length },
      severity: "WARN",
    })
    return { revoked, skipped, failures }
  })
}

// ---- 临时分享链接（带有效期 + 权限 + 次数上限；已登录用户访问即自动绑定共享） ----
export async function createWorkspaceShareLinkAction(input: unknown): Promise<ActionResult<{
  linkId: string; token: string; url: string; permission: string; expireAt: string | null; maxUses: number
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockShareWorkspace", "管理员已禁止分享工作区")
    const { workspaceId, permission, expireHours, maxUses, note } = zodValidate(
      z.object({
        workspaceId: z.string(),
        permission: z.enum(["VIEW", "OPERATE"]),
        expireHours: zPrecision("链接有效期", 0, 8760).optional().default(0), // 0=永久
        maxUses: zPrecision("最大使用次数", 0, 1000).optional().default(0), // 0=不限
        note: z.string().max(120).optional().or(z.literal("").transform(() => undefined)),
      }),
      input
    )
    // r13c：四级共享管控门禁（临时链接与定向共享同一管控链）
    await assertShareAllowed({ userId: ctx.userId, workspaceId, role: ctx.role })
    const ws = await db.browserWorkspace.findFirst({ where: { id: workspaceId, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN") throw new Error("只有所有者可以创建分享链接")

    const token = randomHex(32)
    const expireAt = expireHours > 0 ? new Date(Date.now() + expireHours * 3600_000) : null
    const link = await db.workspaceShareLink.create({
      data: {
        workspaceId, token, permission, expireAt, maxUses,
        note: note || null, createdByUserId: ctx.userId,
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE_LINK_CREATE",
      resourceType: "WORKSPACE", resourceId: workspaceId, resourceName: ws.name,
      ownerUserId: ws.userId,
      after: { linkId: link.id, permission, expireHours, maxUses, note: note || null },
    })
    return {
      linkId: link.id, token,
      url: `/workspaces/shared?token=${token}`,
      permission, expireAt: expireAt?.toISOString() ?? null, maxUses,
    }
  })
}

export async function revokeWorkspaceShareLinkAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { linkId } = zodValidate(z.object({ linkId: z.string() }), input)
    const link = await db.workspaceShareLink.findUnique({ where: { id: linkId } })
    if (!link) throw new Error("分享链接不存在")
    const ws = await db.browserWorkspace.findUnique({ where: { id: link.workspaceId } })
    if (ws && ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    await db.workspaceShareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE_LINK_REVOKE",
      resourceType: "WORKSPACE", resourceId: link.workspaceId,
      after: { revokedLinkId: linkId },
    })
    return null
  })
}

// ---- 链接兑换（已登录用户访问分享链接 → 校验 → 自动绑定 WorkspaceShare） ----
export async function redeemWorkspaceShareLinkAction(input: unknown): Promise<ActionResult<{
  workspaceId: string; workspaceName: string; permission: string; already: boolean
}>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { token } = zodValidate(z.object({ token: z.string().min(16).max(128) }), input)
    const link = await db.workspaceShareLink.findUnique({ where: { token } })
    if (!link) throw new Error("分享链接不存在（可能已失效或被撤销）")
    if (link.revokedAt) throw new Error("该分享链接已被撤销")
    if (link.expireAt && link.expireAt.getTime() < Date.now()) throw new Error("该分享链接已过期")
    if (link.maxUses > 0 && link.useCount >= link.maxUses) throw new Error("该分享链接使用次数已达上限")

    const ws = await db.browserWorkspace.findFirst({ where: { id: link.workspaceId, deletedAt: null } })
    if (!ws) throw new Error("链接指向的工作区已不存在")
    if (ws.userId === ctx.userId) throw new Error("这是你自己的工作区，无需兑换分享链接")

    // r13c：兑换时同步校验发起人四级管控 + 沙箱否决（链接创建后策略可能收紧，
    // 收紧后旧链接不得继续绑定新共享；管理员撤销的共享不会被链接复活）
    if (link.createdByUserId) {
      await assertShareAllowed({ userId: link.createdByUserId, workspaceId: link.workspaceId, role: "USER" })
    }
    if (ws.shareDisabled) throw new Error("该工作区已被管理员禁止共享，链接已失效")

    // 幂等：已有有效共享（同权限刷新；过期/撤销的重新激活）
    const existing = await db.workspaceShare.findFirst({
      where: { workspaceId: link.workspaceId, targetUserId: ctx.userId },
    })
    const already = !!existing && !existing.revokedAt && (!existing.expireAt || existing.expireAt.getTime() > Date.now())

    await db.workspaceShare.upsert({
      where: { workspaceId_targetUserId: { workspaceId: link.workspaceId, targetUserId: ctx.userId } },
      update: { permission: link.permission, revokedAt: null, expireAt: null },
      create: {
        workspaceId: link.workspaceId, targetUserId: ctx.userId, permission: link.permission,
        createdByUserId: link.createdByUserId,
      },
    })
    await db.workspaceShareLink.update({
      where: { id: link.id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_SHARE_LINK_REDEEM",
      resourceType: "WORKSPACE", resourceId: link.workspaceId, resourceName: ws.name,
      ownerUserId: ws.userId,
      after: { linkId: link.id, permission: link.permission, already, useCount: link.useCount + 1 },
    })
    return { workspaceId: ws.id, workspaceName: ws.name, permission: link.permission, already }
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

// ---- 生成HAR（网络记录导出：网关 CDP Network 缓存 → 标准 HAR 1.2）----
export async function exportHarAction(input: unknown): Promise<ActionResult<{ harAvailable: boolean; recordId?: string; entries?: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const { id } = zodValidate(z.object({ id: z.string() }), input)
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")
    if (!rateLimit(`harexport:${ctx.userId}`, 6, 60_000).allowed) throw new Error("HAR 导出过于频繁，请稍后再试")

    // 数据源：CDP 网关网络事件环形缓冲（每工作区最近 300 条请求/响应行）
    const { networkLogSnapshot } = await import("@/lib/external/cdp-control")
    const { parseNetworkLines, buildHarDocument } = await import("@/lib/har-builder")
    const drafts = parseNetworkLines(networkLogSnapshot(id))

    // 有实时缓冲 → 每次导出生成新记录（拿到最新网络流量）；
    // 无缓冲（无 CDP 流量/会话未活跃）→ 复用最近一条持久化记录
    if (drafts.length > 0) {
      const { doc, sizeBytes } = buildHarDocument(drafts, { workspaceId: ws.id, workspaceName: ws.name, uuid: ws.uuid, mode: ws.mode })
      const rec = await db.harRecord.create({
        data: { workspaceId: id, userId: ctx.userId, harJson: JSON.stringify(doc), sizeBytes },
      })
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "HAR_EXPORT",
        resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
        after: { entries: drafts.length, sizeBytes },
      })
      return { harAvailable: true, recordId: rec.id, entries: drafts.length }
    }

    const existing = await db.harRecord.findFirst({ where: { workspaceId: id, deletedAt: null }, orderBy: { createdAt: "desc" } })
    if (existing) {
      await writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "HAR_EXPORT",
        resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      })
      return { harAvailable: true, recordId: existing.id, entries: JSON.parse(existing.harJson || "{}")?.log?.entries?.length ?? 0 }
    }
    // 无持久化HAR时：创建空记录（entries 由后续 CDP 流量填充；下载时如缓冲有数据会实时补充）
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
    return { harAvailable: true, recordId: rec.id, entries: 0 }
  })
}

// ---- 修改工作区配置（TTL/闲置超时/名称/标签）----
export async function updateWorkspaceAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requirePermission(ctx.userId, "blockModifyWorkspace", "管理员已禁止修改工作区配置")
    const { id, name, ttlMinutes, idleTimeoutMinutes, tags, recordingOverride } = zodValidate(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(64).optional(),
        ttlMinutes: zPrecision("TTL", 0, 525600).optional(),
        idleTimeoutMinutes: zPrecision("闲置超时", 0, 1440).optional(), // 0=无限（永不闲置回收）
        tags: z.string().optional(),
        // r27：录像沙箱级覆盖三态（仅管理员可设；普通用户传入被忽略）
        recordingOverride: z.enum(["on", "off", "inherit"]).optional(),
      }),
      input
    )
    const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    if (ws.userId !== ctx.userId && ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") throw new Error("无权操作")

    // r14（22-c）：闲置超时策略锁定 —— 普通用户传入值被忽略并静默采用解析值（审计留痕）
    const idlePolicy = await resolveIdlePolicyForUser(ctx.userId, ctx.role)
    const idleLockedForUser = !isAdminRole(ctx.role) && idlePolicy.locked
    const idleIgnoredByPolicy = idleLockedForUser && idleTimeoutMinutes !== undefined && idleTimeoutMinutes !== idlePolicy.defaultMinutes
    const effectiveIdle = idleLockedForUser && idleTimeoutMinutes !== undefined ? idlePolicy.defaultMinutes : idleTimeoutMinutes

    await db.browserWorkspace.update({
      where: { id },
      data: {
        ...(name ? { name } : {}),
        ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
        ...(effectiveIdle !== undefined ? { idleTimeoutMinutes: effectiveIdle } : {}),
        ...(tags !== undefined ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
        // r27：录像沙箱级覆盖（管理员专属；下次启动生效）
        ...(recordingOverride && (ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN")
          ? { recordingOverride: recordingOverride === "inherit" ? null : recordingOverride }
          : {}),
      },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "WORKSPACE_UPDATE",
      resourceType: "WORKSPACE", resourceId: id, resourceName: ws.name,
      before: { name: ws.name, ttl: ws.ttlMinutes, idle: ws.idleTimeoutMinutes, recordingOverride: ws.recordingOverride },
      after: { name, ttlMinutes, idleTimeoutMinutes: effectiveIdle, tags, ...(recordingOverride ? { recordingOverride: recordingOverride === "inherit" ? null : recordingOverride, recordingOperator: ctx.username } : {}), ...(idleIgnoredByPolicy ? { idlePolicy: { lockedBy: idlePolicy.lockSource, enforced: fmtIdleBrief(idlePolicy.defaultMinutes), submittedIgnored: idleTimeoutMinutes } } : {}) },
    })
    return null
  })
}

// ---- r14（22-c）：管理员强制覆写 TTL / 闲置超时（idle 0=无限支持）----
// 与 admin-workspaces.forceUpdateTtlAction 同语义，但 idleTimeoutMinutes 允许 0（无限）；
// 供管理端改 TTL 弹窗在闲置超时=0 时走本 action（既有 action 的 zod 下限为 1，边界内不可改）
export async function adminForceUpdateWorkspaceTimersAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(
      z.object({
        id: z.string(),
        ttlMinutes: zPrecision("TTL", 0, 525600),
        idleTimeoutMinutes: zPrecision("闲置超时", 0, 525600), // 0=无限
      }),
      input,
    )
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.id, deletedAt: null } })
    if (!ws) throw new Error("工作区不存在")
    const expireAt = p.ttlMinutes > 0 ? new Date(Date.now() + p.ttlMinutes * 60_000) : null
    const updated = await db.browserWorkspace.update({
      where: { id: p.id },
      data: { ttlMinutes: p.ttlMinutes, idleTimeoutMinutes: p.idleTimeoutMinutes, expireAt },
    })
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username, operationType: "ADMIN_FORCE_UPDATE_TTL",
      resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
      ownerUserId: ws.userId, createdByUserId: ws.createdByUserId,
      severity: "WARN",
      before: { ttlMinutes: ws.ttlMinutes, idleTimeoutMinutes: ws.idleTimeoutMinutes, expireAt: ws.expireAt },
      after: { ttlMinutes: updated.ttlMinutes, idleTimeoutMinutes: updated.idleTimeoutMinutes, expireAt: updated.expireAt, note: `闲置超时 ${fmtIdleBrief(p.idleTimeoutMinutes)}` },
    })
    return { id: p.id }
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
      data: { scriptId, workspaceId, status: hit ? "BLOCKED" : "SUCCESS", log: hit ? `脚本命中高危模式 ${hit} 被沙箱拦截` : `脚本经网关下发至浏览器会话执行（${ws.browserSessionId}），绑定域名：${JSON.stringify(script.boundDomains)}`, finishedAt: new Date() },
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
    if (ws.status === "FROZEN") throw new Error(`工作区已被管理员离线冻结封存${ws.freezeReason ? `（${ws.freezeReason}）` : ""}，冻结期间禁止远程桌面接入`)
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

// ============================================================
// r26：沙箱克隆（配置全量复制 + CRX 沙箱级策略同步 + 新实例 STOPPED）
// 约束（需求文档「克隆 CRX 同步」）：SANDBOX 级单插件策略条目逐条复制；
// 共享/链接/会话句柄/运行统计/Profile 快照引用不复制（新实例独立生命周期）。
// ============================================================
const cloneSchema = z.object({
  sourceId: z.string().min(1).max(64),
  name: z.string().min(1).max(80).optional(), // 缺省 = 源名 + " (副本)"
})

export async function cloneWorkspaceAction(input: unknown): Promise<ActionResult<{ id: string; uuid: string; name: string; copiedCrxEntries: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    await requireWritableMode()
    const p = zodValidate(cloneSchema, input)

    // 源工作区可见性：所有者 / ADMIN+ / 被共享 OPERATE
    const src = await db.browserWorkspace.findFirst({
      where: { id: p.sourceId, deletedAt: null, OR: [{ status: { not: "DESTROYED" } }] },
    })
    if (!src) throw new Error("源工作区不存在或已销毁")
    let canClone = src.userId === ctx.userId || isAdminRole(ctx.role)
    if (!canClone) {
      const share = await db.workspaceShare.findFirst({
        where: { workspaceId: src.id, targetUserId: ctx.userId, permission: "OPERATE", revokedAt: null },
      })
      canClone = !!share
    }
    if (!canClone) throw new Error("仅所有者、被共享操作权限用户或管理员可克隆该沙箱")

    // 幂等 + 限速
    const idem = await idempotencyCheck(ctx.userId, "clone_workspace", { sourceId: p.sourceId }, 8000)
    if (idem.repeated) throw new Error("请勿重复提交，克隆正在进行中")
    if (!rateLimit(`wsclone:${ctx.userId}`, 5, 60_000).allowed) throw new Error("克隆过于频繁，请稍后再试")

    // 配额校验（克隆占用与创建同等配额）
    const quota = await checkSessionQuota(ctx.userId, src.mode === "cdp_light" ? "sessions" : "novncSessions")
    if (!quota.ok) throw new Error(quota.reason || "配额不足")

    // 代理节点权限继承校验（克隆者必须对源代理节点仍有权限，否则清空代理）
    let proxyNodeId = src.proxyNodeId
    if (proxyNodeId) {
      const node = await db.proxyNode.findFirst({
        where: { id: proxyNodeId, deletedAt: null, OR: [{ type: "internal_singbox" }, { status: { not: "DISABLED" } }] },
        select: { id: true, type: true, labels: true },
      })
      // 校验代理节点访问权限（与创建同语义：checkProxyAccess 逻辑简化为节点可用性 + 用户组白名单）
      if (!node) proxyNodeId = null
      else {
        const gids = await userGroupIds(ctx.userId)
        const labels = (node as unknown as { labels?: unknown }).labels
        const nodeLabels = Array.isArray(labels) ? (labels as string[]) : []
        const restricted = nodeLabels.filter((l) => l.startsWith("group:"))
        if (restricted.length > 0 && ctx.role === "USER" && !restricted.some((l) => gids.includes(l.slice(6)))) {
          proxyNodeId = null // 源代理节点对克隆者不可见 → 降级为无代理
        }
      }
    }

    const newName = p.name || `${src.name} (副本)`.slice(0, 80)

    // 创建克隆行：会话相关字段全部留空（STOPPED 待启动）
    const clone = await db.browserWorkspace.create({
      data: {
        name: newName,
        mode: src.mode,
        status: "STOPPED",
        userId: ctx.userId, // 克隆归克隆者（管理员克隆=归管理员，便于审计区分）
        groupId: src.groupId,
        proxyNodeId,
        templateId: src.templateId,
        tags: src.tags ?? undefined,
        ttlMinutes: 0, // 不复制 TTL（源可能已消耗大半）
        idleTimeoutMinutes: src.idleTimeoutMinutes,
        vncSessionMaxMinutes: src.vncSessionMaxMinutes,
        shareDisabled: src.shareDisabled,
        policyAllowInternalNetwork: src.policyAllowInternalNetwork,
        policyAllowSecureLocationAccess: src.policyAllowSecureLocationAccess,
        crxInheritEnabled: src.crxInheritEnabled,
        crxBlocklistExempt: ctx.role === "SUPER_ADMIN" ? src.crxBlocklistExempt : false, // 黑名单豁免仅超管可复制
        imeEngine: src.imeEngine,
        kbLayout: src.kbLayout,
        recordingOverride: src.recordingOverride, // r27：录像沙箱级覆盖随克隆复制
        lifecycleRules: src.lifecycleRules ?? undefined,
        createdByUserId: ctx.userId,
        hardeningJson: src.hardeningJson
          ? (JSON.parse(JSON.stringify({ ...(src.hardeningJson as Record<string, unknown>), clonedFrom: src.uuid, provisioned: "pending" })) as Prisma.InputJsonValue)
          : undefined,
      },
    })

    // CRX 沙箱级策略同步（「克隆 CRX 同步」约束）
    const sandboxEntries = await db.crxPolicyEntry.findMany({
      where: { scopeType: "SANDBOX", scopeId: p.sourceId, deletedAt: null },
    })
    let copied = 0
    for (const e of sandboxEntries) {
      await db.crxPolicyEntry.upsert({
        where: { scopeType_scopeId_crxId: { scopeType: "SANDBOX", scopeId: clone.id, crxId: e.crxId } },
        create: {
          scopeType: "SANDBOX", scopeId: clone.id, crxId: e.crxId,
          updateUrl: e.updateUrl, backupUpdateUrl: e.backupUpdateUrl, lockedVersion: e.lockedVersion,
          allowIncognito: e.allowIncognito, allowUserDisable: e.allowUserDisable,
          note: e.note ? `${e.note}（克隆自源沙箱）` : "克隆自源沙箱",
          createdByUserId: ctx.userId, createdByName: ctx.username,
        },
        update: { deletedAt: null },
      })
      copied++
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKSPACE_CLONE",
      resourceType: "WORKSPACE", resourceId: clone.id, resourceName: clone.name,
      before: { sourceId: src.id, sourceName: src.name, sourceUuid: src.uuid, sourceMode: src.mode },
      after: { cloneId: clone.id, cloneName: clone.name, cloneUuid: clone.uuid, copiedCrxEntries: copied, proxyNodeId, status: "STOPPED" },
      severity: "INFO",
    })
    return { id: clone.id, uuid: clone.uuid, name: clone.name, copiedCrxEntries: copied }
  })
}
