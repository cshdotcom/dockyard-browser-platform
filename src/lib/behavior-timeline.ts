// ============================================================
// r29-g：行为监控时间轴核心（沙箱全行为统一时间线）
//   数据源：浏览历史（BrowseHistoryEntry）/ 文件操作（AuditLog FILE_*）/
//          网络请求（HarRecord）/ 系统审计事件（WORKSPACE 域）
//   纯采集与合并（无鉴权；action 层管权限）
// ============================================================

import { db } from "./db"

export interface TimelineEvent {
  ts: string
  kind: "browse" | "file" | "network" | "system"
  title: string
  detail?: string | null
  actor?: string | null
}

export async function buildBehaviorTimeline(params: {
  workspaceId: string
  fromMin?: number
  keyword?: string
  take?: number
}): Promise<{ events: TimelineEvent[]; counts: { browse: number; file: number; network: number; system: number } }> {
  const windowMs = (params.fromMin || 1440) * 60_000
  const since = new Date(Date.now() - windowMs)
  const kw = params.keyword || null
  const p = { workspaceId: params.workspaceId, fromMin: params.fromMin || 1440, keyword: params.keyword, take: params.take }

  const [history, fileAudits, systemAudits, har] = await Promise.all([
    db.browseHistoryEntry.findMany({
      where: { workspaceId: p.workspaceId, visitAt: { gte: since }, ...(kw ? { OR: [{ url: { contains: kw } }, { title: { contains: kw } }, { domain: { contains: kw } }] } : {}) },
      select: { url: true, title: true, domain: true, visitAt: true, dwellMs: true },
      orderBy: { visitAt: "desc" }, take: 250,
    }),
    db.auditLog.findMany({
      where: { resourceId: p.workspaceId, createdAt: { gte: since }, operationType: { startsWith: "FILE_" } },
      select: { operationType: true, afterJson: true, operatorName: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: 250,
    }),
    db.auditLog.findMany({
      where: { resourceId: p.workspaceId, createdAt: { gte: since }, operationType: { not: { startsWith: "FILE_" } } },
      select: { operationType: true, afterJson: true, operatorName: true, createdAt: true, severity: true },
      orderBy: { createdAt: "desc" }, take: 250,
    }),
    db.harRecord.findMany({
      where: { workspaceId: p.workspaceId, createdAt: { gte: since }, deletedAt: null },
      select: { sizeBytes: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: 100,
    }),
  ])

  const events: TimelineEvent[] = []
  for (const h of history) {
    events.push({
      ts: h.visitAt.toISOString(), kind: "browse",
      title: h.title || h.domain || h.url.slice(0, 80),
      detail: `${h.domain || "-"} · 停留 ${Math.round((h.dwellMs || 0) / 1000)}s · ${h.url.slice(0, 160)}`,
    })
  }
  for (const a of fileAudits) {
    events.push({ ts: a.createdAt.toISOString(), kind: "file", title: a.operationType, detail: (a.afterJson || "").slice(0, 180), actor: a.operatorName })
  }
  for (const a of systemAudits) {
    events.push({ ts: a.createdAt.toISOString(), kind: "system", title: a.operationType, detail: (a.afterJson || "").slice(0, 180), actor: a.operatorName })
  }
  for (const h of har) {
    events.push({ ts: h.createdAt.toISOString(), kind: "network", title: `HAR 网络请求记录（${Math.round(h.sizeBytes / 1024)}KB）`, detail: "网络请求瀑布存档" })
  }

  events.sort((a, b) => (a.ts < b.ts ? 1 : -1))
  return {
    events: events.slice(0, p.take || 300),
    counts: { browse: history.length, file: fileAudits.length, network: har.length, system: systemAudits.length },
  }
}
