// ============================================================
// r28b：用户组管理共享筛选（对齐用户管理 URL 筛选参数模式）
// · 页面（树形展示）与 CSV 导出路由复用同一语义：
//   keyword（组名/描述/标签/组员用户名 模糊）、enabled（启停）、
//   createdFrom / createdTo（创建日期范围）
// · 树形展示额外保留命中节点的祖先链（父组不命中也显示以维持层级结构）
// ============================================================

export interface GroupFilterParams {
  keyword?: string | null
  enabled?: string | null
  createdFrom?: string | null
  createdTo?: string | null
}

export interface GroupFilterRow {
  id: string
  name: string
  description: string | null
  parentId: string | null
  enabled: boolean
  createdAt: Date | string
  tags: string[]
}

export interface MembershipRow {
  groupId: string
  userId: string
}

export interface GroupsFilterResult {
  /** 命中筛选条件的组 ID（不含仅为维持层级而保留的祖先） */
  matched: Set<string>
  /** 命中 + 祖先链（树形展示用） */
  visible: Set<string>
}

function toTime(v: string | null | undefined): number | null {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

// 判断是否有任一筛选条件生效
export function hasGroupFilter(p: GroupFilterParams): boolean {
  return !!(p.keyword?.trim() || p.enabled === "true" || p.enabled === "false" || p.createdFrom || p.createdTo)
}

export function filterGroups(
  groups: GroupFilterRow[],
  memberships: MembershipRow[],
  usernameById: Map<string, string>,
  p: GroupFilterParams
): GroupsFilterResult {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const matched = new Set<string>()

  // 无筛选：全部可见
  if (!hasGroupFilter(p)) {
    for (const g of groups) matched.add(g.id)
    return { matched, visible: new Set(matched) }
  }

  const kw = (p.keyword || "").trim().toLowerCase()
  const enabledWant = p.enabled === "true" ? true : p.enabled === "false" ? false : null
  const from = p.createdFrom ? toTime(p.createdFrom) : null
  const to = p.createdTo ? toTime(`${p.createdTo}T23:59:59`) : null

  // keyword 命中的组员所在组（组员用户名搜索，数据库 where 无法表达 → 名称集合）
  let memberHitGroupIds: Set<string> | null = null
  if (kw) {
    memberHitGroupIds = new Set<string>()
    for (const m of memberships) {
      const uname = usernameById.get(m.userId)
      if (uname && uname.toLowerCase().includes(kw)) memberHitGroupIds.add(m.groupId)
    }
  }

  for (const g of groups) {
    if (enabledWant !== null && g.enabled !== enabledWant) continue
    const created = new Date(g.createdAt).getTime()
    if (from !== null && created < from) continue
    if (to !== null && created > to) continue
    if (kw) {
      const selfHit =
        g.name.toLowerCase().includes(kw)
        || (g.description || "").toLowerCase().includes(kw)
        || g.tags.some((t) => t.toLowerCase().includes(kw))
        || (memberHitGroupIds?.has(g.id) ?? false)
      if (!selfHit) continue
    }
    matched.add(g.id)
  }

  // 祖先链（仅树形展示需要：命中节点的全部未删除祖先保留）
  const visible = new Set(matched)
  for (const id of matched) {
    let cur = byId.get(id)?.parentId || null
    const guard = new Set<string>()
    while (cur && byId.has(cur) && !guard.has(cur)) {
      guard.add(cur)
      visible.add(cur)
      cur = byId.get(cur)?.parentId || null
    }
  }

  return { matched, visible }
}
