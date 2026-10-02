import { resolveShareControl } from "@/lib/share-policy"
import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { fmtDate, fmtBytes } from "@/lib/utils-server"
import { ENV } from "@/lib/env"
import { getConfig, getConfigBool } from "@/lib/config"
import { resolveIdlePolicyForWorkspace } from "@/lib/idle-policy"
import { WorkspaceDetail } from "./detail-tabs"

export const metadata = { title: "工作区详情" }

export default async function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth()
  const { id } = await params
  const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
  if (!ws) notFound()

  // 权限：所有者 / 被共享 / 管理员
  const gids = await userGroupIds(ctx.userId)
  // r13c：四级共享管控解析（供所有者共享按钮禁用态；管理员豁免）
  const ownerShareControl = await resolveShareControl({ userId: ctx.userId, role: ctx.role, workspaceId: id })
  const shareControlBlockReason = !ownerShareControl.allowed
    ? ownerShareControl.reason
    : ws.shareDisabled
      ? "该工作区已被管理员禁止共享（沙箱级否决）"
      : ""

  const share = await db.workspaceShare.findFirst({
    where: { workspaceId: id, targetUserId: ctx.userId, revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
  })
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  if (ws.userId !== ctx.userId && !share && !isAdmin && !(ctx.role === "GROUP_ADMIN" && ws.groupId && gids.includes(ws.groupId))) {
    notFound()
  }

  const [proxyNode, singbox, owner, creator, shares, scripts, harRecords, runLogs, snap, shareLinks] = await Promise.all([
    ws.proxyNodeId ? db.proxyNode.findUnique({ where: { id: ws.proxyNodeId } }) : null,
    ws.singboxInstanceId ? db.singboxInstance.findUnique({ where: { id: ws.singboxInstanceId } }) : null,
    db.user.findUnique({ where: { id: ws.userId }, select: { username: true, displayName: true, email: true } }),
    ws.createdByUserId ? db.user.findUnique({ where: { id: ws.createdByUserId }, select: { username: true, displayName: true } }) : null,
    db.workspaceShare.findMany({ where: { workspaceId: id, revokedAt: null } }),
    db.browserScriptTemplate.findMany({
      where: { deletedAt: null, enabled: true, OR: [{ scope: "GLOBAL" }, { userId: ctx.userId }] },
      select: { id: true, name: true, description: true, scope: true },
    }),
    db.harRecord.findMany({ where: { workspaceId: id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
    db.browserScriptRunLog.findMany({ where: { workspaceId: id }, orderBy: { startedAt: "desc" }, take: 10 }),
    ws.profileSnapshotId ? db.browserProfileSnapshot.findUnique({ where: { id: ws.profileSnapshotId } }) : null,
    db.workspaceShareLink.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
  ])
  const shareTargets = shares.length > 0
    ? await db.user.findMany({ where: { id: { in: shares.map((s) => s.targetUserId) } }, select: { id: true, username: true, displayName: true } })
    : []

  const shareMap = new Map(shareTargets.map((u) => [u.id, u]))

  // 公网 CDP 网关端点（PUBLIC_BASE_URL 等环境变量配置后展示，内网穿透/域名部署场景）
  // 外部工具（Puppeteer/Playwright/自定义脚本）应使用该端点，而非内部 ws://steel-internal 地址
  const publicCdpEndpoint = ENV.publicBaseUrl
    ? `${ENV.publicBaseUrl}/api/cdp/command`
    : ""

  // r14（22-c）：闲置超时四级策略链解析（生效值+来源徽章；锁定态按查看者角色豁免管理员）
  const idlePolicyWs = await resolveIdlePolicyForWorkspace(ws.id).catch(() => null)
  const idleLockedForViewer = !!idlePolicyWs && idlePolicyWs.ownerPolicy.locked && !isAdmin

  // 四层生效策略（单沙箱 > 用户 > 用户组 > 全局）：详情页展示与沙箱级覆盖面板数据源
  const { resolveAccessPolicies } = await import("@/lib/domain-policy")
  const effBundleRaw = ws.mode === "novnc_full"
    ? await resolveAccessPolicies(ws.userId, ws.id).catch(() => null)
    : null
  const effBundle = effBundleRaw
    ? {
        network: {
          allowInternalNetwork: effBundleRaw.network.allowInternalNetwork,
          allowSecureLocationAccess: effBundleRaw.network.allowSecureLocationAccess,
          source: effBundleRaw.network.source,
        },
        domain: {
          mode: effBundleRaw.domain.mode,
          black: effBundleRaw.domain.blackPatterns.length,
          white: effBundleRaw.domain.whitePatterns.length,
          rules: effBundleRaw.domain.rules.length,
        },
        endpoint: { black: effBundleRaw.endpoint.blackPatterns.length, white: effBundleRaw.endpoint.whitePatterns.length },
        file: {
          allowDownload: effBundleRaw.file.allowDownload,
          allowUpload: effBundleRaw.file.allowUpload,
          allowFileScheme: effBundleRaw.file.allowFileScheme,
          source: effBundleRaw.file.source,
        },
      }
    : null

  return (
    <WorkspaceDetail
      workspace={{
        id: ws.id, uuid: ws.uuid, name: ws.name, mode: ws.mode, status: ws.status,
        tags: (ws.tags as string[]) || [],
        ttlMinutes: ws.ttlMinutes, idleTimeoutMinutes: ws.idleTimeoutMinutes,
        cdpCallCount: ws.cdpCallCount, cdpBlockedCount: ws.cdpBlockedCount,
        novncConnCount: ws.novncConnCount, novncFps: ws.novncFps, novncActiveMin: ws.novncActiveMin,
        cdpUrl: ws.cdpUrl, steelSessionId: ws.steelSessionId, novncSessionId: ws.novncSessionId,
        containerRef: ws.containerRef,
        hardening: (ws.hardeningJson as Record<string, unknown> | null) ?? null,
        createdAt: fmtDate(ws.createdAt), updatedAt: fmtDate(ws.updatedAt),
        proxyName: proxyNode?.name ?? null, proxyType: proxyNode?.type ?? null, proxyStatus: proxyNode?.status ?? null,
        singboxId: singbox?.id ?? null, singboxName: singbox?.name ?? null,
        snapshotId: snap?.id ?? null, snapshotName: snap?.name ?? null, snapshotSize: snap?.sizeBytes ?? 0,
        ownerName: owner?.displayName || owner?.username || "-",
        ownerEmail: owner?.email ?? null,
        creatorName: creator ? (creator.displayName || creator.username) : null,
        isOwner: ws.userId === ctx.userId,
        mySharePermission: share?.permission ?? null,
        isAdmin,
        shareDisabled: ws.shareDisabled === true,
        shareBlockedReason: shareControlBlockReason,
        crashCategory: ws.crashCategory,
        policyAllowInternalNetwork: ws.policyAllowInternalNetwork,
        policyAllowSecureLocationAccess: ws.policyAllowSecureLocationAccess,
        effectivePolicy: effBundle,
        idleInfo: idlePolicyWs
          ? {
              minutes: idlePolicyWs.resolution.minutes,
              source: idlePolicyWs.resolution.source,
              sourceLabel: idlePolicyWs.resolution.sourceLabel,
              locked: idleLockedForViewer,
              lockSourceLabel: idlePolicyWs.ownerPolicy.lockSourceLabel,
            }
          : null,
        // r23：VNC 全局策略（workspace.vncDefaultMode/vncForceMode/vncWatermark/vncAutoQuality 真实生效）
        vncPolicy: {
          defaultMode: await getConfig<string>("workspace.vncDefaultMode", "auto"),
          forceMode: await getConfig<string>("workspace.vncForceMode", ""),
          watermark: await getConfigBool("workspace.vncWatermark", true),
          autoQuality: await getConfigBool("workspace.vncAutoQuality", true),
        },
      }}
      shares={shares.map((s) => ({
        id: s.id, targetName: shareMap.get(s.targetUserId)?.displayName || shareMap.get(s.targetUserId)?.username || "-",
        permission: s.permission, expireAt: s.expireAt ? fmtDate(s.expireAt) : null, createdAt: fmtDate(s.createdAt),
      }))}
      shareLinks={shareLinks.map((l) => ({
        id: l.id,
        token: l.token,
        permission: l.permission,
        expireAt: l.expireAt ? fmtDate(l.expireAt) : null,
        revokedAt: l.revokedAt ? fmtDate(l.revokedAt) : null,
        maxUses: l.maxUses,
        useCount: l.useCount,
        lastUsedAt: l.lastUsedAt ? fmtDate(l.lastUsedAt) : null,
        note: l.note,
        createdAt: fmtDate(l.createdAt),
      }))}
      scripts={scripts.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "", scope: s.scope }))}
      harRecords={harRecords.map((h) => ({ id: h.id, size: fmtBytes(h.sizeBytes), createdAt: fmtDate(h.createdAt) }))}
      runLogs={runLogs.map((l) => ({ id: l.id, status: l.status, log: l.log ?? "", startedAt: fmtDate(l.startedAt) }))}
      publicCdpEndpoint={publicCdpEndpoint}
      vncBridge={{ mode: ENV.vncBridgePublic, url: ENV.vncBridgeUrl }}
    />
  )
}
