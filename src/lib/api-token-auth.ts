import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sha256 } from "./crypto"
import { rateLimit } from "./rate-limit"
import { checkIpRisk } from "./risk"
import { trackBehavior } from "./risk"
import { getConfigNumber } from "./config"

// API-Token 鉴权中间件：所有 /api/mcp、/api/openapi 外部调用统一走这里
// 校验链：密钥哈希 → 启用状态 → 过期时间 → IP白名单 → QPS限流 → 权限位掩码
// 全程写调用日志（含 wasExpired 标记）；五重隔离：APIKey(租户) + UUID(资源) + SessionID(客户端) + DeviceID(设备)

export const TOKEN_PERM = {
  READ: 1,
  WRITE: 2,
  EXECUTE: 4,
  ADMIN: 8,
} as const

export interface ApiTokenContext {
  tokenId: string
  userId: string
  username: string
  permissions: number
  role: string
}

interface AuthResult {
  ok: boolean
  status: number
  body: { code: number; msg: string; traceId: string }
  ctx?: ApiTokenContext
}

function trace() {
  return crypto.randomUUID()
}

export async function authenticateApiToken(
  req: NextRequest,
  requiredPerm: number
): Promise<AuthResult> {
  const traceId = trace()
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "127.0.0.1"
  const apiKey = req.headers.get("x-api-key") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || ""
  const path = req.nextUrl.pathname

  const fail = (code: number, msg: string, status = 401) => ({ ok: false, status, body: { code, msg, traceId } })

  if (!apiKey) return fail(40100, "缺少 API-Key（请求头 x-api-key）")

  // ---- 风控黑白名单（外部通道：黑白名单都生效） ----
  const ipRisk = await checkIpRisk(ip)
  if (ipRisk.blocked) {
    return fail(46001, `风控拦截：${ipRisk.reason}`, 403)
  }

  // ---- 密钥校验 ----
  const tokenHash = sha256(apiKey)
  const token = await db.apiToken.findFirst({ where: { tokenHash, deletedAt: null } })
  if (!token) return fail(40100, "API-Key 无效")

  // wasExpired 检查（记录调用日志时标记）
  const expired = !!token.expireAt && token.expireAt < new Date()
  const startMs = Date.now()

  const writeLog = async (status: number) => {
    await db.apiTokenCallLog
      .create({
        data: {
          tokenId: token!.id,
          tokenUserId: token!.userId,
          path,
          method: req.method,
          status,
          durationMs: Date.now() - startMs,
          wasExpired: expired,
          ip,
          traceId,
        },
      })
      .catch(() => {})
  }

  if (expired) {
    await writeLog(401)
    return fail(41101, "Token 已过期")
  }
  if (!token.enabled) {
    await writeLog(403)
    return fail(40300, "Token 已被禁用", 403)
  }

  // ---- IP 白名单 ----
  if (token.ipWhitelist && Array.isArray(token.ipWhitelist) && (token.ipWhitelist as string[]).length > 0) {
    const list = token.ipWhitelist as string[]
    const matched = list.some((pattern) => {
      if (pattern.includes("/")) return cidrMatch(ip, pattern)
      return pattern === ip
    })
    if (!matched) {
      await writeLog(403)
      return fail(40300, "调用IP不在该Token白名单内", 403)
    }
  }

  // ---- QPS 限流（独立配置：单token每秒；再叠加每分钟/每小时的mcp配额） ----
  const globalQps = await getConfigNumber("rate.tokenQps", 100)
  const qps = token.qpsLimit > 0 ? token.qpsLimit : globalQps
  if (!rateLimit(`token:${token.id}`, qps, 1000).allowed) {
    await writeLog(429)
    return fail(42900, "Token QPS 超限", 429)
  }
  const perSec = await getConfigNumber("mcp.perKeyPerSecond", 20)
  const perMin = await getConfigNumber("mcp.perKeyPerMinute", 300)
  const perHour = await getConfigNumber("mcp.perKeyPerHour", 5000)
  if (!rateLimit(`mcp-sec:${token.id}`, perSec, 1000).allowed) { await writeLog(429); return fail(42900, "单Key每秒配额超限", 429) }
  if (!rateLimit(`mcp-min:${token.id}`, perMin, 60_000).allowed) { await writeLog(429); return fail(42900, "单Key每分钟配额超限", 429) }
  if (!rateLimit(`mcp-hour:${token.id}`, perHour, 3600_000).allowed) { await writeLog(429); return fail(42900, "单Key每小时配额超限", 429) }

  // ---- 权限位掩码 ----
  if ((token.permissionsMask & requiredPerm) !== requiredPerm) {
    await writeLog(403)
    return fail(40300, "Token 权限不足（缺少所需权限位）", 403)
  }

  const user = await db.user.findUnique({ where: { id: token.userId } })
  if (!user || user.deletedAt || !user.enabled) {
    await writeLog(403)
    return fail(40300, "Token 所属用户不可用", 403)
  }

  // 调用计数
  await db.apiToken.update({ where: { id: token.id }, data: { lastCallAt: new Date(), callCount: { increment: 1 } } }).catch(() => {})
  void trackBehavior(token.userId, "MCP_CALL").catch(() => {})

  return {
    ok: true,
    status: 200,
    body: { code: 0, msg: "ok", traceId },
    ctx: { tokenId: token.id, userId: token.userId, username: user.username, permissions: token.permissionsMask, role: user.role },
  }
}

// 携带调用日志的响应封装
export async function tokenResponse(
  req: NextRequest,
  ctx: ApiTokenContext | undefined,
  fn: () => Promise<NextResponse>
): Promise<NextResponse> {
  if (!ctx) return fn()
  const start = Date.now()
  try {
    const res = await fn()
    await db.apiTokenCallLog
      .create({
        data: {
          tokenId: ctx.tokenId,
          tokenUserId: ctx.userId,
          path: req.nextUrl.pathname,
          method: req.method,
          status: res.status,
          durationMs: Date.now() - start,
          wasExpired: false,
          traceId: req.headers.get("x-trace-id") || trace(),
        },
      })
      .catch(() => {})
    return res
  } catch (e) {
    return NextResponse.json(
      { code: 50000, msg: "服务内部错误", traceId: trace() },
      { status: 500 }
    )
  }
}

function cidrMatch(ip: string, cidr: string): boolean {
  try {
    const [base, bitsStr] = cidr.split("/")
    const bits = Number(bitsStr)
    const toInt = (s: string) => s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0)
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
    return (toInt(ip) & mask) === (toInt(base) & mask)
  } catch {
    return false
  }
}

// 资源归属字段（OpenAPI 输出统一规范）
export async function attachOwnership<T extends Record<string, unknown>>(rows: T[]): Promise<(T & {
  ownerUserId: string | null
  ownerUserName: string | null
  createdByUserId: string | null
  createdByUserName: string | null
})[]> {
  const ownerIds = [...new Set(rows.map((r) => (r.userId as string) || (r.ownerUserId as string)).filter(Boolean))] as string[]
  const creatorIds = [...new Set(rows.map((r) => r.createdByUserId as string).filter(Boolean))]
  const allIds = [...new Set([...ownerIds, ...creatorIds])]
  const users = allIds.length > 0 ? await db.user.findMany({ where: { id: { in: allIds } }, select: { id: true, username: true, displayName: true } }) : []
  const map = new Map(users.map((u) => [u.id, u.displayName || u.username]))
  return rows.map((r) => {
    const owner = (r.userId as string) || (r.ownerUserId as string) || null
    return {
      ...r,
      ownerUserId: owner,
      ownerUserName: owner ? map.get(owner) ?? null : null,
      createdByUserId: (r.createdByUserId as string) || null,
      createdByUserName: r.createdByUserId ? map.get(r.createdByUserId as string) ?? null : null,
    }
  })
}
