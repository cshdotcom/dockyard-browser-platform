/**
 * r28：浏览历史 / 书签采集引擎
 *
 * 数据来源：
 *  - 浏览历史：CDP HTTP /json/list 轮询（沙箱 RUNNING 时每 2 分钟；同 URL 120s 内合并停留时长）
 *  - 书签：读取 Profile/Bookmarks JSON（root 后台专属用户隔离下唯一合法通道；
 *          沙箱用户浏览器进程自身可读写自己 Profile，但平台侧以 root 读全量对账）
 *
 * 隔离语义：
 *  - 记录严格绑定 workspaceId + userId（沙箱级隔离：用户只能看自己沙箱的记录）
 *  - 采集通道仅服务端 root 权限，用户侧无法伪造（CDP 端点仅容器网络可达）
 */

import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { writeAudit } from "@/lib/audit"
import { classifyEntry } from "@/lib/data-classification"
import type { BrowserWorkspace } from "@prisma/client"

// ---- 跳过的页面 URL 前缀（非用户浏览行为） ----
const SKIP_URL_PREFIXES = [
  "about:",
  "chrome://",
  "edge://",
  "chrome-extension://",
  "devtools://",
  "view-source:",
  "data:",
  "blob:",
]

export function isUserFacingUrl(url: string): boolean {
  if (!url || url.length < 4) return false
  return !SKIP_URL_PREFIXES.some((p) => url.startsWith(p))
}

export function extractDomain(url: string): string | null {
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).hostname
    if (/^file:\/\//i.test(url)) return "file://"
    return null
  } catch {
    return null
  }
}

// ---- CDP /json/list 页面枚举 ----
interface CdpPageInfo { targetId?: string; id?: string; url?: string; title?: string; type?: string; webSocketDebuggerUrl?: string }

export async function listWorkspacePages(cdpUrl: string): Promise<CdpPageInfo[] | null> {
  try {
    const httpUrl = cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "") + "/json/list"
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const targets = (await res.json().catch(() => [])) as CdpPageInfo[]
    return (targets || []).filter((t) => t.type === "page")
  } catch {
    return null
  }
}

// ============================================================
// 一、浏览历史采集（增量 + 停留时长合并）
// ============================================================

const DWELL_MERGE_WINDOW_MS = 120_000 // 同 URL 120 秒内视为同一访问合并停留

export async function collectWorkspaceHistory(ws: Pick<BrowserWorkspace, "id" | "uuid" | "userId" | "cdpUrl" | "status">): Promise<{ pages: number; inserted: number; merged: number }> {
  if (ws.status !== "RUNNING" || !ws.cdpUrl) return { pages: 0, inserted: 0, merged: 0 }
  const pages = await listWorkspacePages(ws.cdpUrl)
  if (!pages) return { pages: 0, inserted: 0, merged: 0 }

  const userPages = pages.filter((p) => isUserFacingUrl(p.url || ""))
  const now = new Date()

  // 每个去重 URL 取一条（多标签同 URL 只算一次访问）
  const seen = new Set<string>()
  let inserted = 0
  let merged = 0

  for (const p of userPages) {
    const url = p.url as string
    if (seen.has(url)) continue
    seen.add(url)
    const domain = extractDomain(url)

    const recent = await db.browseHistoryEntry.findFirst({
      where: {
        workspaceId: ws.id,
        url,
        visitAt: { gte: new Date(now.getTime() - DWELL_MERGE_WINDOW_MS) },
        deletedAt: null,
      },
      orderBy: { visitAt: "desc" },
    })
    if (recent) {
      // 合并停留时长 + 刷新标题
      await db.browseHistoryEntry.update({
        where: { id: recent.id },
        data: {
          dwellMs: recent.dwellMs + 10_000,
          title: p.title || recent.title || undefined,
        },
      })
      merged++
    } else {
      // r37：写入时自动分类（明文数据识别解析：分类 + 敏感级别）
      const cls = classifyEntry(url, p.title)
      await db.browseHistoryEntry.create({
        data: {
          workspaceId: ws.id,
          workspaceUuid: ws.uuid,
          userId: ws.userId,
          url: url.slice(0, 2048),
          title: (p.title || "").slice(0, 512) || null,
          domain,
          category: cls.category,
          sensitivity: cls.sensitivity,
          visitAt: now,
          dwellMs: 10_000,
          source: "CDP_POLL",
        },
      })
      inserted++
    }
  }
  return { pages: userPages.length, inserted, merged }
}

// ============================================================
// 二、书签采集（Profile/Bookmarks JSON 对账）
// ============================================================

interface ChromiumBookmarkNode {
  guid?: string
  url?: string
  name?: string
  type?: string
  date_added?: string // Chromium epoch（微秒，1601 起）
  children?: ChromiumBookmarkNode[]
}

interface FlatBookmark { guid: string; url: string; name: string; folder: string; position: number; dateAdded: Date | null }

/** Chromium 书签时间戳（1601-01-01 起的微秒）→ Date */
function chromiumTimeToDate(v?: string): Date | null {
  if (!v) return null
  const us = Number(v)
  if (!Number.isFinite(us) || us <= 0) return null
  return new Date(Date.UTC(1601, 0, 1) + us / 1000)
}

function flattenBookmarkTree(node: ChromiumBookmarkNode, folderPath: string, out: FlatBookmark[], depth = 0): void {
  if (depth > 12 || out.length > 2000) return // 防深递归/超大树
  const children = node.children || []
  let pos = 0
  for (const child of children) {
    const name = (child.name || "").slice(0, 512)
    if (child.type === "url" && child.url && child.guid) {
      if (!isUserFacingUrl(child.url)) continue // 跳过 chrome:// 等内部书签
      out.push({
        guid: child.guid,
        url: child.url.slice(0, 2048),
        name,
        folder: folderPath || null || "书签栏",
        position: pos++,
        dateAdded: chromiumTimeToDate(child.date_added),
      })
    } else if (child.type === "folder") {
      flattenBookmarkTree(child, folderPath ? `${folderPath}/${name}` : name, out, depth + 1)
    }
  }
}

export function parseChromiumBookmarks(jsonText: string): FlatBookmark[] {
  try {
    const data = JSON.parse(jsonText) as { roots?: Record<string, ChromiumBookmarkNode> }
    const roots = data.roots || {}
    const out: FlatBookmark[] = []
    // 顺序：bookmark_bar → other → synced（位置段连续）
    let posOffset = 0
    for (const key of ["bookmark_bar", "other", "synced"]) {
      const root = roots[key]
      if (!root) continue
      const startIdx = out.length
      const displayName = (root.name || (key === "bookmark_bar" ? "书签栏" : key === "other" ? "其他书签" : "移动书签"))
      flattenBookmarkTree(root, displayName, out)
      for (let i = startIdx; i < out.length; i++) out[i].position += posOffset
      posOffset += 1000 // 根目录段间隔
    }
    return out
  } catch {
    return []
  }
}

/** Profile 路径推导：storage/profiles/<userId>/<profileKey>（与快照导出一致） */
export function resolveWorkspaceProfileDir(userId: string | null, hardeningJson: unknown): string | null {
  try {
    const hard = (hardeningJson || {}) as { profileKey?: string }
    if (!userId || !hard?.profileKey) return null
    return [ENV.storageLocalPath, "profiles", userId, hard.profileKey].join("/").replace("//", "/")
  } catch {
    return null
  }
}

export async function collectWorkspaceBookmarks(ws: Pick<BrowserWorkspace, "id" | "uuid" | "userId"> & { hardeningJson: unknown }): Promise<{ parsed: number; upserted: number; removed: number; skipped: boolean }> {
  const fs = await import("fs/promises")
  const path = await import("path")
  const dir = resolveWorkspaceProfileDir(ws.userId, (ws as { hardeningJson?: unknown }).hardeningJson)
  if (!dir) return { parsed: 0, upserted: 0, removed: 0, skipped: true }

  const bookmarkFile = path.join(dir, "Bookmarks")
  let text: string
  try {
    text = await fs.readFile(bookmarkFile, "utf-8")
  } catch {
    return { parsed: 0, upserted: 0, removed: 0, skipped: true }
  }

  const flat = parseChromiumBookmarks(text)
  const now = new Date()
  const seenGuids = new Set<string>()

  for (const b of flat) {
    seenGuids.add(b.guid)
    // r37：写入时自动分类（书签明文数据识别解析）
    const bCls = classifyEntry(b.url, b.name)
    await db.bookmarkEntry.upsert({
      where: { workspaceId_guid: { workspaceId: ws.id, guid: b.guid } },
      create: {
        workspaceId: ws.id,
        workspaceUuid: ws.uuid,
        userId: ws.userId,
        guid: b.guid,
        url: b.url,
        title: b.name || null,
        folder: b.folder || null,
        category: bCls.category,
        sensitivity: bCls.sensitivity,
        position: b.position,
        dateAdded: b.dateAdded,
        lastSyncAt: now,
      },
      update: {
        url: b.url,
        title: b.name || null,
        folder: b.folder || null,
        category: bCls.category,
        sensitivity: bCls.sensitivity,
        position: b.position,
        dateAdded: b.dateAdded,
        lastSyncAt: now,
        removedAt: null, // 用户重新添加时复活
      },
    }).catch(() => null)
  }

  // 对账：库里 guid 不在当前 Profile 文件中 → 用户已删除 → 标记 removedAt（软保留）
  const existing = await db.bookmarkEntry.findMany({
    where: { workspaceId: ws.id, removedAt: null },
    select: { id: true, guid: true },
  })
  let removed = 0
  for (const row of existing) {
    if (row.guid && !seenGuids.has(row.guid)) {
      await db.bookmarkEntry.update({ where: { id: row.id }, data: { removedAt: now } }).catch(() => null)
      // 用户删除书签 → 审计留痕（本地删除行为归档，平台记录不随沙箱销毁）
      await writeAudit({
        operationType: "BOOKMARK_LOCAL_DELETE",
        resourceType: "BOOKMARK",
        resourceId: row.id,
        resourceName: "用户本地删除书签",
        ownerUserId: ws.userId || undefined,
        after: { workspaceId: ws.id, guid: row.guid, detectedAt: now.toISOString(), source: "BOOKMARK_RECONCILE" },
        severity: "INFO",
      }).catch(() => null)
      removed++
    }
  }

  return { parsed: flat.length, upserted: flat.length, removed, skipped: false }
}

// ============================================================
// 三、批量采集入口（定时任务 / 手动触发共用）
// ============================================================

export async function collectAllRunningBrowsing(): Promise<{ workspaces: number; historyInserted: number; historyMerged: number; bookmarkWorkspaces: number; bookmarkUpserted: number; bookmarkRemoved: number }> {
  const running = await db.browserWorkspace.findMany({
    where: { status: "RUNNING", deletedAt: null, cdpUrl: { not: null } },
    select: { id: true, uuid: true, userId: true, cdpUrl: true, status: true, hardeningJson: true },
    take: 200,
  })

  let historyInserted = 0
  let historyMerged = 0
  let bookmarkWorkspaces = 0
  let bookmarkUpserted = 0
  let bookmarkRemoved = 0

  // 历史采集：串行（避免 CDP 并发压力；沙箱数有限）
  for (const ws of running) {
    try {
      const r = await collectWorkspaceHistory(ws)
      historyInserted += r.inserted
      historyMerged += r.merged
    } catch { /* 单沙箱失败不阻断 */ }
  }

  // 书签采集：每轮全部对账（成本低，文件读取）
  for (const ws of running) {
    try {
      const r = await collectWorkspaceBookmarks(ws as never)
      if (!r.skipped) {
        bookmarkWorkspaces++
        bookmarkUpserted += r.upserted
        bookmarkRemoved += r.removed
      }
    } catch { /* 单沙箱失败不阻断 */ }
  }

  return { workspaces: running.length, historyInserted, historyMerged, bookmarkWorkspaces, bookmarkUpserted, bookmarkRemoved }
}
