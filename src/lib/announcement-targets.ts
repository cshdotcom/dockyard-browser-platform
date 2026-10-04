// ============================================================
// 公告范围多选解析（r30）
//
// 背景：管理员发布公告时，用户与用户组均可多选 + 搜索（此前仅单选：type=GROUP
// 只能选一个组、type=USER 只能选一个用户）。
//
// 存储设计（新旧兼容，零迁移成本）：
//   · groupIdsJson / userIdsJson —— JSON 数组，全部目标
//   · groupId / userId —— 兼容字段 = 数组首项（旧单选数据本来就在这两个字段上；
//     旧客户端按单值查询/展示的逻辑在单目标场景下行为完全不变）
//   · type —— GLOBAL（无目标）/ GROUP（仅组）/ USER（含用户，可混合组）
//     可见性匹配一律走本文件 union 判定，不依赖 type 枚举拆分
// ============================================================

export interface AnnouncementTargetFields {
  groupId?: string | null
  userId?: string | null
  groupIdsJson?: string | null
  userIdsJson?: string | null
}

function parseIds(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
  } catch {
    return []
  }
}

// 公告的全部目标用户组（数组 ∪ 兼容单值字段；去重）
export function announcementGroupIds(a: AnnouncementTargetFields): string[] {
  return Array.from(new Set([...parseIds(a.groupIdsJson), ...(a.groupId ? [a.groupId] : [])]))
}

// 公告的全部目标用户（数组 ∪ 兼容单值字段；去重）
export function announcementUserIds(a: AnnouncementTargetFields): string[] {
  return Array.from(new Set([...parseIds(a.userIdsJson), ...(a.userId ? [a.userId] : [])]))
}

// 某用户是否命中公告范围（GLOBAL 或 组∈其组 / 用户=其本人）
// gids：该用户所属的全部组 id（调用方预取，避免 N+1）
export function announcementTargetsUser(
  a: AnnouncementTargetFields & { type?: string | null },
  userId: string,
  userGroupIds: string[],
): boolean {
  if (a.type === "GLOBAL" && !a.groupId && !a.userId && !a.groupIdsJson && !a.userIdsJson) return true
  if (announcementUserIds(a).includes(userId)) return true
  const gids = announcementGroupIds(a)
  if (gids.length > 0 && userGroupIds.some((g) => gids.includes(g))) return true
  return false
}

// 范围摘要（管理列表/审计展示用）：如「2 组 + 3 用户」「开发组」「全站」
export function announcementScopeSummary(
  a: AnnouncementTargetFields & { type?: string | null },
  opts: { groupName?: (id: string) => string | undefined; userName?: (id: string) => string | undefined } = {},
): string {
  const gids = announcementGroupIds(a)
  const uids = announcementUserIds(a)
  if (gids.length === 0 && uids.length === 0) return "全站"
  const parts: string[] = []
  if (gids.length > 0) {
    if (gids.length === 1) {
      parts.push(opts.groupName ? opts.groupName(gids[0]) || gids[0] : gids[0])
    } else {
      parts.push(`${gids.length} 个组`)
    }
  }
  if (uids.length > 0) {
    if (uids.length === 1) {
      parts.push(opts.userName ? opts.userName(uids[0]) || uids[0] : uids[0])
    } else {
      parts.push(`${uids.length} 位用户`)
    }
  }
  return parts.join(" + ")
}
