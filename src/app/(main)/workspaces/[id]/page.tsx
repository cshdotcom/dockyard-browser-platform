import { notFound } from "next/navigation"
import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { fmtDate, fmtBytes } from "@/lib/utils-server"
import { WorkspaceDetail } from "./detail-tabs"

export const metadata = { title: "工作区详情" }

export default async function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth()
  const { id } = await params
  const ws = await db.browserWorkspace.findFirst({ where: { id, deletedAt: null } })
  if (!ws) notFound()

  // 权限：所有者 / 被共享 / 管理员
  const gids = await userGroupIds(ctx.userId)
  const share = await db.workspaceShare.findFirst({
    where: { workspaceId: id, targetUserId: ctx.userId, revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
  })
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  if (ws.userId !== ctx.userId && !share && !isAdmin && !(ctx.role === "GROUP_ADMIN" && ws.groupId && gids.includes(ws.groupId))) {
    notFound()
  }

  const [proxyNode, singbox, owner, creator, shares, shareTargets, scripts, harRecords, runLogs, snap, novncHealth] = await Promise.all([
    ws.proxyNodeId ? db.proxyNode.findUnique({ where: { id: ws.proxyNodeId } }) : null,
    ws.singboxInstanceId ? db.singboxInstance.findUnique({ where: { id: ws.singboxInstanceId } }) : null,
    db.user.findUnique({ where: { id: ws.userId }, select: { username: true, displayName: true, email: true } }),
    ws.createdByUserId ? db.user.findUnique({ where: { id: ws.createdByUserId }, select: { username: true, displayName: true } }) : null,
    db.workspaceShare.findMany({ where: { workspaceId: id, revokedAt: null } }),
    db.user.findMany({ where: { id: { in: shares.map((s) => s.targetUserId) } }, select: { id: true, username: true, displayName: true } }),
    db.browserScriptTemplate.findMany({
      where: { deletedAt: null, enabled: true, OR: [{ scope: "GLOBAL" }, ...(gids.length ? [{ scope: "GROUP", groupId: { in: gids } }] : []), { userId: ctx.userId }] },
      select: { id: true, name: true, description: true, scope: true },
    }),
    db.harRecord.findMany({ where: { workspaceId: id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 5 }),
    db.browserScriptRunLog.findMany({ where: { workspaceId: id }, orderBy: { startedAt: "desc" }, take: 10 }),
    ws.profileSnapshotId ? db.browserProfileSnapshot.findUnique({ where: { id: ws.profileSnapshotId } }) : null,
    Promise.resolve(null),
  ])

  const shareMap = new Map(shareTargets.map((u) => [u.id, u]))

  return (
    <WorkspaceDetail
      workspace={{
        id: ws.id, uuid: ws.uuid, name: ws.name, mode: ws.mode, status: ws.status,
        tags: (ws.tags as string[]) || [],
        ttlMinutes: ws.ttlMinutes, idleTimeoutMinutes: ws.idleTimeoutMinutes,
        cdpCallCount: ws.cdpCallCount, cdpBlockedCount: ws.cdpBlockedCount,
        novncConnCount: ws.novncConnCount, novncFps: ws.novncFps, novncActiveMin: ws.novncActiveMin,
        cdpUrl: ws.cdpUrl, steelSessionId: ws.steelSessionId, novncSessionId: ws.novncSessionId,
        createdAt: fmtDate(ws.createdAt), updatedAt: fmtDate(ws.updatedAt),
        proxyName: proxyNode?.name ?? null, proxyType: proxyNode?.type ?? null, proxyStatus: proxyNode?.status ?? null,
        singboxId: singbox?.id ?? null, singboxName: singbox?.name ?? null,
        snapshotId: snap?.id ?? null, snapshotName: snap?.name ?? null, snapshotSize: snap?.sizeBytes ?? 0,
        ownerName: owner?.displayName || owner?.username || "-",
        ownerEmail: owner?.email,
        creatorName: creator ? (creator.displayName || creator.username) : null,
        isOwner: ws.userId === ctx.userId,
        mySharePermission: share?.permission ?? null,
        isAdmin,
        crashCategory: ws.crashCategory,
      }}
      shares={shares.map((s) => ({
        id: s.id, targetName: shareMap.get(s.targetUserId)?.displayName || shareMap.get(s.targetUserId)?.username || "-",
        permission: s.permission, expireAt: s.expireAt ? fmtDate(s.expireAt) : null, createdAt: fmtDate(s.createdAt),
      }))}
      scripts={scripts.map((s) => ({ id: s.id, name: s.name, description: s.description ?? "", scope: s.scope }))}
      harRecords={harRecords.map((h) => ({ id: h.id, size: fmtBytes(h.sizeBytes), createdAt: fmtDate(h.createdAt) }))}
      runLogs={runLogs.map((l) => ({ id: l.id, status: l.status, log: l.log ?? "", startedAt: fmtDate(l.startedAt) }))}
    />
  )
}
