// ============================================================
// Token 权限级别 + 功能范围（scope）—— 纯函数定义模块
// 客户端 / 服务端双端安全（无 db / next/server 依赖）
// ============================================================

export const TOKEN_PERM = {
  READ: 1,
  WRITE: 2,
  EXECUTE: 4,
  ADMIN: 8,
} as const

// Token 权限级别（掩码快捷语义，创建/编辑时二选一）
export const TOKEN_LEVELS = {
  READ_ONLY: { mask: TOKEN_PERM.READ, label: "只读" },
  READ_WRITE: { mask: TOKEN_PERM.READ | TOKEN_PERM.WRITE | TOKEN_PERM.EXECUTE, label: "读写" },
} as const
export type TokenLevel = keyof typeof TOKEN_LEVELS

export function levelOfMask(mask: number): TokenLevel | "ADMIN" | "CUSTOM" {
  if (mask === TOKEN_LEVELS.READ_ONLY.mask) return "READ_ONLY"
  if (mask === TOKEN_LEVELS.READ_WRITE.mask) return "READ_WRITE"
  if ((mask & TOKEN_PERM.ADMIN) !== 0) return "ADMIN"
  return "CUSTOM"
}

export function levelLabel(mask: number): string {
  const lv = levelOfMask(mask)
  if (lv === "READ_ONLY") return "只读"
  if (lv === "READ_WRITE") return "读写"
  if (lv === "ADMIN") return "管理级"
  return "自定义"
}

// ============================================================
// 功能范围（scope）白名单体系
// null / 空数组 = 不限（全功能面）；非空 = 仅允许命中的功能面
// 与权限位（只读/读写）正交：scope 决定「能用哪些功能」，权限位决定「能读还是能写」
// ============================================================
export const TOKEN_SCOPES = [
  { key: "browser", label: "浏览器工作区", desc: "工作区创建/启停/销毁/CDP控制/批量编排" },
  { key: "proxy", label: "代理与 Sing-Box", desc: "代理节点启停/重启/批量编排" },
  { key: "user", label: "用户管理操作", desc: "批量启禁/强制下线/配额重置/权限锁" },
  { key: "token", label: "令牌管理操作", desc: "批量设置有效期/批量作废令牌" },
  { key: "recycle", label: "回收站", desc: "批量恢复/彻底销毁/模板复制" },
  { key: "session", label: "会话与强制管控", desc: "批量下线会话/强制停止/强制重启工作区" },
  { key: "crx", label: "扩展（CRX）管控", desc: "扩展库/安装记录/灰度任务查询与下发" },
  { key: "resources", label: "资源只读查询", desc: "工作区/审计/回收站等资源列表查询" },
] as const
export type TokenScopeKey = (typeof TOKEN_SCOPES)[number]["key"]
const SCOPE_KEYS = new Set<string>(TOKEN_SCOPES.map((s) => s.key))

export function isScopeKey(s: unknown): s is TokenScopeKey {
  return typeof s === "string" && SCOPE_KEYS.has(s)
}

// null/[] → null（不限）；非空 → 去重合法 scope 数组
export function normalizeScopes(input: unknown): string[] | null {
  if (input === null || input === undefined) return null
  if (!Array.isArray(input)) return null
  const list = input.filter(isScopeKey)
  return list.length > 0 ? [...new Set(list)] : null
}

export function scopeLabel(key: string): string {
  return TOKEN_SCOPES.find((s) => s.key === key)?.label || key
}

// MCP 操作码 → scope 映射（引擎逐工具功能面控制；精确条目优先）
const MCP_CODE_SCOPE_RULES: [prefix: string, scope: string][] = [
  ["workspace.batch_replace_proxy", "proxy"],
  ["workspace.", "browser"],
  ["singbox.", "proxy"],
  ["user.", "user"],
  ["token.", "token"],
  ["recycle.", "recycle"],
  ["template.", "recycle"],
  ["session.", "session"],
  ["admin.", "session"],
  ["task.", "resources"],
]
export function scopeForMcpCode(code: string): string | null {
  for (const [p, s] of MCP_CODE_SCOPE_RULES) if (code === p) return s
  for (const [p, s] of MCP_CODE_SCOPE_RULES) if (code.startsWith(p)) return s
  return null
}

// scope 白名单校验（MCP 网关在鉴权后按操作码二次调用）
export function checkTokenScope(
  ctx: { scopes: string[] | null } | undefined,
  requiredScope: string | null,
): { ok: boolean; msg: string } {
  if (!requiredScope) return { ok: true, msg: "" }
  if (!ctx?.scopes || ctx.scopes.length === 0) return { ok: true, msg: "" } // 不限
  if (ctx.scopes.includes(requiredScope)) return { ok: true, msg: "" }
  return { ok: false, msg: `Token 功能范围未授权：缺少「${scopeLabel(requiredScope)}」（${requiredScope}）` }
}
