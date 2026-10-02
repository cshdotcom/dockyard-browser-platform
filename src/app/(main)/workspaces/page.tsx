import { db } from "@/lib/db"
import { requireAuth, userGroupIds } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { resolveShareControl } from "@/lib/share-policy"
import { resolveIdlePolicyForUser } from "@/lib/idle-policy"
import { WorkspacesTable } from "./workspaces-table"

export const metadata = { title: "浏览器工作区" }

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)

  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  const mode = q.filters.mode
  const status = q.filters.status

  // 权限隔离：普通用户只看自己的 + 共享给他的；管理员看全部
  const gids = await userGroupIds(ctx.userId)
  const sharedIds = await db.workspaceShare.findMany({
    where: { targetUserId: ctx.userId, revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
    select: { workspaceId: true },
  })

  const where = isAdmin
    ? {
        deletedAt: null,
        ...(mode ? { mode } : {}),
        ...(status ? { status } : {}),
        ...(q.keyword ? { OR: [{ name: { contains: q.keyword } }, { uuid: { contains: q.keyword } }] } : {}),
      }
    : {
        deletedAt: null,
        OR: [{ userId: ctx.userId }, { id: { in: sharedIds.map((s) => s.workspaceId) } }],
        ...(mode ? { mode } : {}),
        ...(status ? { status } : {}),
        ...(q.keyword ? { AND: [{ OR: [{ name: { contains: q.keyword } }, { uuid: { contains: q.keyword } }] }] } : {}),
      }

  const [rows, total, templates, snapshots, proxyNodes, myQuota, runningCount] = await Promise.all([
    db.browserWorkspace.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "status", "lastUsedAt"], { createdAt: "desc" }) as Record<string, "asc" | "desc">,
    }),
    db.browserWorkspace.count({ where }),
    db.browserTemplate.findMany({
      where: { deletedAt: null, OR: [{ scope: "GLOBAL" }, ...(gids.length ? [{ scope: "GROUP", groupId: { in: gids } }] : []), { userId: ctx.userId }] },
      select: { id: true, name: true, scope: true },
      take: 100,
    }),
    db.browserProfileSnapshot.findMany({
      where: { deletedAt: null, OR: [{ userId: ctx.userId }, ...(gids.length ? [{ scope: "GROUP", groupId: { in: gids } }] : []), { scope: "GLOBAL" }] },
      select: { id: true, name: true },
      take: 100,
    }),
    db.proxyNode.findMany({
      where: { deletedAt: null, status: { in: ["HEALTHY", "DEGRADED", "UNKNOWN"] } },
      select: { id: true, name: true, type: true, status: true },
      take: 100,
    }),
    db.user.findUnique({ where: { id: ctx.userId }, select: { quota: true } }),
    db.browserWorkspace.count({ where: { userId: ctx.userId, status: { in: ["RUNNING", "CREATING", "IDLE"] }, deletedAt: null } }),
  ])

  // 归属用户名映射
  const userIds = [...new Set(rows.map((r) => r.userId).filter(Boolean))]
  const users = userIds.length > 0 ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, displayName: true } }) : []
  const userMap = new Map(users.map((u) => [u.id, u]))

  // r13c：四级共享管控解析（一次解析用户/组/全局层，沙箱级否决逐行叠加）
  // 仅对自己的行计算（被共享行的共享入口在所有者侧）
  const baseShareControl = await resolveShareControl({ userId: ctx.userId, role: ctx.role })

  // r14（22-c）：闲置超时四级策略链（创建表单默认值 + 锁定态；管理员不受锁定）
  const idlePolicy = await resolveIdlePolicyForUser(ctx.userId, ctx.role)

  const data = rows.map((r) => {
    const isOwner = r.userId === ctx.userId
    let shareControl: { allowed: boolean; reason: string } | undefined
    if (isOwner) {
      if (!baseShareControl.allowed) {
        shareControl = { allowed: false, reason: baseShareControl.reason }
      } else if (r.shareDisabled) {
        shareControl = { allowed: false, reason: "该工作区已被管理员禁止共享（沙箱级否决）" }
      } else {
        shareControl = { allowed: true, reason: "" }
      }
    }
    return {
      id: r.id,
      uuid: r.uuid,
      name: r.name,
      mode: r.mode,
      status: r.status,
      ownerName: userMap.get(r.userId)?.displayName || userMap.get(r.userId)?.username || "-",
      isOwner,
      isShared: sharedIds.some((s) => s.workspaceId === r.id),
      proxyNodeId: r.proxyNodeId,
      singboxInstanceId: r.singboxInstanceId,
      ttlMinutes: r.ttlMinutes,
      idleTimeoutMinutes: r.idleTimeoutMinutes,
      cdpCallCount: r.cdpCallCount,
      novncConnCount: r.novncConnCount,
      tags: (r.tags as string[]) || [],
      createdAt: fmtDate(r.createdAt),
      profileSnapshotId: r.profileSnapshotId,
      browserSessionId: r.browserSessionId,
      novncSessionId: r.novncSessionId,
      shareControl,
    }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">浏览器工作区</h1>
        <p className="text-sm text-muted-foreground mt-1">
          CDP 轻量会话与 NoVNC 重度人机交互会话 · {isAdmin ? "管理员视图（全部用户）" : "我的工作区与共享给我的会话"}
          {!isAdmin && ` · 运行中 ${runningCount}/${((myQuota?.quota as Record<string, number>)?.sessions) ?? "未限制"}`}
        </p>
      </div>
      <WorkspacesTable
        rows={data}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={{ mode: q.filters.mode, status: q.filters.status }}
        templates={templates}
        snapshots={snapshots}
        proxyNodes={proxyNodes}
        isAdmin={isAdmin}
        currentUserId={ctx.userId}
        idlePolicy={{
          locked: idlePolicy.locked,
          minutes: idlePolicy.defaultMinutes,
          sourceLabel: idlePolicy.defaultSourceLabel,
          lockSourceLabel: idlePolicy.lockSourceLabel,
        }}
      />
    </div>
  )
}
