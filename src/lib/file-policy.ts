// ============================================================
// 文件访问限制策略（File Access Policy）
// 管理员按【单沙箱 > 用户 > 用户组（沿继承链）> 全局】四层控制浏览器会话：
//   1. allowDownload   —— 是否允许下载文件（false → Chromium DownloadRestrictions=2 全禁）
//   2. allowUpload     —— 是否允许选择本机文件上传（false → AllowFileSelectionDialogs=false，文件拾取器封禁）
//   3. allowFileScheme —— 是否允许 file:// 本地文件访问（false → URLBlocklist file://*）
//
// 解析优先级（逐级回退，配置条目表 FilePolicyConfig unique[scopeType,scopeId]）：
//   SANDBOX（单沙箱级覆盖，非 null 即生效，最高优先）
//     > USER（用户级条目）
//       > GROUP（所属组，沿 parentId 继承链向上取第一个显式条目）
//         > GLOBAL（全局条目）
//           > 系统默认（allowDownload=true / allowUpload=true / allowFileScheme=false）
//
// 执行层：Chromium 托管策略（与网络/域名/端点策略合并写入同一份只读 bind-mount
// 策略文件 /etc/chromium/policies/managed/dockyard.json，容器内不可篡改）。
// 下载落盘目录本身位于容器隔离卷（只读根 FS + 独立下载目录），平台侧另有文件审计。
// ============================================================

import { db } from "./db"

export interface FilePolicy {
  allowDownload: boolean
  allowUpload: boolean
  allowFileScheme: boolean
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL" | "DEFAULT"
  sourceGroupId?: string | null
  resolvedAt: string
}

export const FILE_POLICY_DEFAULTS: Omit<FilePolicy, "resolvedAt"> = {
  allowDownload: true,
  allowUpload: true,
  allowFileScheme: false,
  source: "DEFAULT",
}

// ---- 单目标解析（userId 必传；workspaceId 可选 —— 传入即启用沙箱级最高优先）----
export async function resolveFilePolicy(userId: string, workspaceId?: string | null): Promise<FilePolicy> {
  const resolvedAt = new Date().toISOString()

  // 1) 沙箱级覆盖（最高优先）
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({
      where: { id: workspaceId },
      select: { userId: true, deletedAt: true },
    })
    if (ws && !ws.deletedAt) {
      // 归属强校验：沙箱级文件策略仅作用于该沙箱所有者的解析链（防越权串扰）
      if (ws.userId === userId) {
        const entry = await db.filePolicyConfig.findUnique({
          where: { scopeType_scopeId: { scopeType: "SANDBOX", scopeId: workspaceId } },
        })
        if (entry) {
          return {
            allowDownload: entry.allowDownload,
            allowUpload: entry.allowUpload,
            allowFileScheme: entry.allowFileScheme,
            source: "SANDBOX",
            resolvedAt,
          }
        }
      }
    }
  }

  // 2) 用户级条目
  const userEntry = await db.filePolicyConfig.findUnique({
    where: { scopeType_scopeId: { scopeType: "USER", scopeId: userId } },
  })
  if (userEntry) {
    return {
      allowDownload: userEntry.allowDownload,
      allowUpload: userEntry.allowUpload,
      allowFileScheme: userEntry.allowFileScheme,
      source: "USER",
      resolvedAt,
    }
  }

  // 3) 组级（沿 parentId 继承链向上，取第一个显式条目）
  const memberships = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  const seen = new Set<string>()
  for (const m of memberships) {
    let cursor: string | null = m.groupId
    let depth = 0
    while (cursor && !seen.has(cursor) && depth < 8) {
      seen.add(cursor)
      const grp = await db.group.findUnique({
        where: { id: cursor },
        select: { parentId: true, deletedAt: true, enabled: true },
      })
      if (grp && !grp.deletedAt && grp.enabled) {
        const entry = await db.filePolicyConfig.findUnique({
          where: { scopeType_scopeId: { scopeType: "GROUP", scopeId: cursor } },
        })
        if (entry) {
          return {
            allowDownload: entry.allowDownload,
            allowUpload: entry.allowUpload,
            allowFileScheme: entry.allowFileScheme,
            source: "GROUP",
            sourceGroupId: cursor,
            resolvedAt,
          }
        }
      }
      cursor = grp?.parentId ?? null
      depth += 1
    }
  }

  // 4) 全局条目
  const globalEntry = await db.filePolicyConfig.findUnique({
    where: { scopeType_scopeId: { scopeType: "GLOBAL", scopeId: "" } },
  })
  if (globalEntry) {
    return {
      allowDownload: globalEntry.allowDownload,
      allowUpload: globalEntry.allowUpload,
      allowFileScheme: globalEntry.allowFileScheme,
      source: "GLOBAL",
      resolvedAt,
    }
  }

  // 5) 系统默认
  return { ...FILE_POLICY_DEFAULTS, resolvedAt }
}

// ---- 批量解析（工作区列表一次装配：按 workspace 归属解析各自四层链）----
export async function resolveFilePoliciesBatch(
  pairs: Array<{ userId: string; workspaceId?: string | null }>,
): Promise<Map<string, FilePolicy>> {
  // key = workspaceId 或 userId（调用方决定键语义：有 workspaceId 用 ws 维度，否则用 user 维度）
  const out = new Map<string, FilePolicy>()
  if (pairs.length === 0) return out
  const resolvedAt = new Date().toISOString()

  const userIds = [...new Set(pairs.map((p) => p.userId))].filter(Boolean)
  const workspaceIds = [...new Set(pairs.map((p) => p.workspaceId).filter((x): x is string => !!x))]

  const [entries, memberships, groups, workspaces] = await Promise.all([
    db.filePolicyConfig.findMany({
      where: { OR: [...userIds.map((id) => ({ scopeType: "USER", scopeId: id })), ...workspaceIds.map((id) => ({ scopeType: "SANDBOX", scopeId: id }))] },
    }),
    db.groupUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, groupId: true } }),
    db.group.findMany({
      where: { deletedAt: null, enabled: true },
      select: { id: true, parentId: true },
    }),
    workspaceIds.length
      ? db.browserWorkspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, userId: true } })
      : Promise.resolve([] as Array<{ id: string; userId: string }>),
  ])

  const groupEntryCache = new Map<string, { allowDownload: boolean; allowUpload: boolean; allowFileScheme: boolean } | null>()
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const groupIdsByUser = new Map<string, string[]>()
  for (const m of memberships) {
    const arr = groupIdsByUser.get(m.userId) || []
    arr.push(m.groupId)
    groupIdsByUser.set(m.userId, arr)
  }
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const entryBy = (type: string, scopeId: string) => entries.find((e) => e.scopeType === type && e.scopeId === scopeId) || null

  const globalEntry = await db.filePolicyConfig.findUnique({
    where: { scopeType_scopeId: { scopeType: "GLOBAL", scopeId: "" } },
  })
  const globalResolved = globalEntry
    ? { allowDownload: globalEntry.allowDownload, allowUpload: globalEntry.allowUpload, allowFileScheme: globalEntry.allowFileScheme }
    : null

  // 组链解析（带缓存：同组多用户不重复查）
  const resolveGroupEntry = async (userId: string) => {
    for (const gid of groupIdsByUser.get(userId) || []) {
      let cursor: string | null = gid
      const seen = new Set<string>()
      let depth = 0
      while (cursor && !seen.has(cursor) && depth < 8) {
        seen.add(cursor)
        if (groupEntryCache.has(cursor)) {
          const hit = groupEntryCache.get(cursor)!
          if (hit) return { ...hit, sourceGroupId: cursor }
        } else {
          const entry = await db.filePolicyConfig.findUnique({
            where: { scopeType_scopeId: { scopeType: "GROUP", scopeId: cursor } },
          })
          const val = entry ? { allowDownload: entry.allowDownload, allowUpload: entry.allowUpload, allowFileScheme: entry.allowFileScheme } : null
          groupEntryCache.set(cursor, val)
          if (val) return { ...val, sourceGroupId: cursor }
        }
        cursor = groupById.get(cursor)?.parentId ?? null
        depth += 1
      }
    }
    return null
  }

  for (const p of pairs) {
    const key = p.workspaceId || p.userId
    // 1) 沙箱级（归属校验：ws.userId === p.userId）
    if (p.workspaceId) {
      const ws = wsById.get(p.workspaceId)
      if (ws && ws.userId === p.userId) {
        const e = entryBy("SANDBOX", p.workspaceId)
        if (e) {
          out.set(key, { allowDownload: e.allowDownload, allowUpload: e.allowUpload, allowFileScheme: e.allowFileScheme, source: "SANDBOX", resolvedAt })
          continue
        }
      }
    }
    // 2) 用户级
    const ue = entryBy("USER", p.userId)
    if (ue) {
      out.set(key, { allowDownload: ue.allowDownload, allowUpload: ue.allowUpload, allowFileScheme: ue.allowFileScheme, source: "USER", resolvedAt })
      continue
    }
    // 3) 组级
    const ge = await resolveGroupEntry(p.userId)
    if (ge) {
      out.set(key, { allowDownload: ge.allowDownload, allowUpload: ge.allowUpload, allowFileScheme: ge.allowFileScheme, source: "GROUP", sourceGroupId: ge.sourceGroupId, resolvedAt })
      continue
    }
    // 4) 全局 / 默认
    if (globalResolved) {
      out.set(key, { ...globalResolved, source: "GLOBAL", resolvedAt })
    } else {
      out.set(key, { ...FILE_POLICY_DEFAULTS, resolvedAt })
    }
  }
  return out
}

// ---- Chromium 托管策略注入（并入 buildChromiumManagedPolicy 统一落盘）----
export function filePolicyManagedPrefs(policy: FilePolicy): Record<string, unknown> {
  const managed: Record<string, unknown> = {}
  if (!policy.allowDownload) {
    // 2 = 全部下载禁止（Chromium DownloadRestrictions：0默认 1拦危险 2全禁 3拦恶意）
    managed.DownloadRestrictions = 2
  }
  if (!policy.allowUpload) {
    // 文件选择拾取器封禁 —— 上传入口（input[type=file]）无法弹出本机文件对话框
    managed.AllowFileSelectionDialogs = false
  }
  return managed
}

// file:// 封禁模式（并入 URLBlocklist）
export function fileSchemeBlockPatterns(): string[] {
  return ["file://*", "file:///*"]
}

// 人读摘要
export function describeFilePolicy(p: FilePolicy): string {
  const src =
    p.source === "SANDBOX" ? "沙箱级覆盖" : p.source === "USER" ? "用户级" : p.source === "GROUP" ? "组级继承" : p.source === "GLOBAL" ? "全局" : "系统默认"
  const dl = p.allowDownload ? "下载允许" : "下载禁止"
  const up = p.allowUpload ? "上传允许" : "上传禁止"
  const fs = p.allowFileScheme ? "file://允许" : "file://禁止"
  return `${src} · ${dl} · ${up} · ${fs}`
}
