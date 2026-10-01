import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { normalizeScopes } from "@/lib/token-scopes"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { KeyRound, Clock, ShieldAlert, Infinity as InfinityIcon } from "lucide-react"
import { TokensTabs } from "./tokens-tabs"
import { TokensTable, type TokenRow } from "./tokens-table"
import { CallLogsTable, type CallLogRow } from "./call-logs-table"

// 我的 API 令牌（用户自助）：列表 + 调用日志页签
// 状态计算：expireAt=null → 永久；>now+warnDays → 正常；>now → 即将到期；<=now → 已过期
export const metadata = { title: "我的 API 令牌" }

export type TokenStatus = "PERMANENT" | "NORMAL" | "EXPIRING" | "EXPIRED"

function tokenStatusOf(expireAt: Date | null, warnDays: number): TokenStatus {
  if (!expireAt) return "PERMANENT"
  const now = Date.now()
  if (expireAt.getTime() <= now) return "EXPIRED"
  if (expireAt.getTime() > now + warnDays * 86400_000) return "NORMAL"
  return "EXPIRING"
}

export default async function TokensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireAuth()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  const tab = sp.tab === "logs" ? "logs" : "list"

  const warnDays = await getConfigNumber("token.expireWarnDays", 7)
  const maxPerUser = await getConfigNumber("token.maxPerUser", 10)
  const allowPermanent = await getConfigBool("token.allowPermanent", true)
  const maxLifetimeDays = await getConfigNumber("token.maxLifetimeDays", 0)

  // ---- 令牌列表 ----
  const where: Record<string, unknown> = { userId: ctx.userId, deletedAt: null }
  if (f.enabled) where.enabled = f.enabled === "true"
  if (q.keyword) {
    where.OR = [{ name: { contains: q.keyword } }, { tokenPrefix: { contains: q.keyword } }]
  }

  const [rows, total, totalCount, activeCount] = await Promise.all([
    db.apiToken.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "expireAt", "lastCallAt", "callCount"], { createdAt: "desc" }),
    }),
    db.apiToken.count({ where }),
    db.apiToken.count({ where: { userId: ctx.userId, deletedAt: null } }),
    db.apiToken.count({ where: { userId: ctx.userId, deletedAt: null, enabled: true } }),
  ])

  const list: TokenRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    // 掩码：仅显示前 8 位前缀
    prefix: `${t.tokenPrefix}••••`,
    permissionsMask: t.permissionsMask,
    scopes: normalizeScopes(t.scopes),
    status: tokenStatusOf(t.expireAt, warnDays),
    enabled: t.enabled,
    qpsLimit: t.qpsLimit,
    ipWhitelist: Array.isArray(t.ipWhitelist) ? (t.ipWhitelist as string[]) : [],
    lastCallAt: fmtDate(t.lastCallAt),
    callCount: t.callCount,
    createdAt: fmtDate(t.createdAt),
    expireAt: t.expireAt ? fmtDate(t.expireAt) : "永久有效",
    expireAtIso: t.expireAt ? t.expireAt.toISOString() : null,
  }))

  // ---- 调用日志页签数据 ----
  let logs: CallLogRow[] = []
  let logsTotal = 0
  let tokenOptions: { id: string; name: string }[] = []
  if (tab === "logs") {
    const lw: Record<string, unknown> = { tokenUserId: ctx.userId }
    if (f.tokenId) lw.tokenId = f.tokenId
    if (q.keyword) lw.path = { contains: q.keyword }

    const [logRows, logCount] = await Promise.all([
      db.apiTokenCallLog.findMany({ where: lw, ...pageSkipTake(q), orderBy: safeOrderBy(q, ["createdAt", "durationMs", "status"], { createdAt: "desc" }) }),
      db.apiTokenCallLog.count({ where: lw }),
    ])
    logsTotal = logCount

    // 日志中出现的 token 名称（含已删除的令牌）
    const tokenIds = [...new Set(logRows.map((r) => r.tokenId).filter((v): v is string => !!v))]
    const tokenNameRows = tokenIds.length
      ? await db.apiToken.findMany({ where: { id: { in: tokenIds } }, select: { id: true, name: true, deletedAt: true } })
      : []
    const nameMap = new Map<string, string>(tokenNameRows.map((t): [string, string] => [t.id, t.name + (t.deletedAt ? "（已删除）" : "")]))

    logs = logRows.map((r) => ({
      id: r.id,
      path: r.path,
      method: r.method,
      status: r.status,
      durationMs: r.durationMs,
      wasExpired: r.wasExpired,
      ip: r.ip,
      tokenName: r.tokenId ? nameMap.get(r.tokenId) || "已删除令牌" : "-",
      createdAt: fmtDate(r.createdAt),
    }))
  }

  // 筛选器 token 选项（用户现存令牌）
  tokenOptions = await db.apiToken.findMany({
    where: { userId: ctx.userId, deletedAt: null },
    select: { id: true, name: true },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">我的 API 令牌</h1>
        <p className="text-sm text-muted-foreground mt-1">
          用于 OpenAPI / MCP 网关鉴权 · 明文仅在创建时展示一次，请妥善保管
        </p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="令牌总数" value={totalCount} sub={`上限 ${maxPerUser} 个`} icon={<KeyRound className="h-4 w-4" />} />
        <StatCard title="启用中" value={activeCount} sub={`${totalCount - activeCount} 个已禁用`} icon={<ShieldAlert className="h-4 w-4" />} tone="success" />
        <StatCard
          title="永久 Token"
          value={allowPermanent ? "允许" : "禁止"}
          sub={allowPermanent ? (ctx.role === "SUPER_ADMIN" ? "你不受限制" : "普通用户可选永久") : "仅超级管理员豁免"}
          icon={<InfinityIcon className="h-4 w-4" />}
        />
        <StatCard
          title="最长有效期"
          value={maxLifetimeDays > 0 ? `${maxLifetimeDays} 天` : "不限"}
          sub={`到期提前 ${warnDays} 天预警`}
          icon={<Clock className="h-4 w-4" />}
        />
      </div>

      <TokensTabs tab={tab}>
        {tab === "list" ? (
          <TokensTable
            rows={list}
            total={total}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            role={ctx.role}
          />
        ) : (
          <CallLogsTable
            rows={logs}
            total={logsTotal}
            page={q.page}
            pageSize={q.pageSize}
            keyword={q.keyword}
            sortField={q.sortField}
            sortOrder={q.sortOrder}
            filters={f}
            tokenOptions={tokenOptions}
          />
        )}
      </TokensTabs>
    </div>
  )
}
