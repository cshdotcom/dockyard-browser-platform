// LRU 内存限流器：按 IP / userId / tokenId 三维度；匿名/登录/Token三套独立阈值
// 内存实现 + 定时清理过期桶

interface Bucket {
  count: number
  resetAt: number
}

const g = globalThis as unknown as {
  __dyRateBuckets?: Map<string, Bucket>
  __dyRateCleaner?: ReturnType<typeof setInterval>
}

function buckets(): Map<string, Bucket> {
  if (!g.__dyRateBuckets) {
    g.__dyRateBuckets = new Map()
    g.__dyRateCleaner = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of g.__dyRateBuckets!) {
        if (v.resetAt < now) g.__dyRateBuckets!.delete(k)
      }
    }, 60_000)
    ;(g.__dyRateCleaner as unknown as { unref?: () => void }).unref?.()
  }
  return g.__dyRateBuckets
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

// 简单滑动窗口（固定窗口计数 + 窗口重置）
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  if (limit <= 0) return { allowed: true, remaining: 999999, resetAt: Date.now() + windowMs }
  const now = Date.now()
  const b = buckets().get(key)
  if (!b || b.resetAt < now) {
    buckets().set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs }
  }
  b.count += 1
  const allowed = b.count <= limit
  return { allowed, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt }
}

// 登录失败计数（内存，用于账号锁定前的快速计数）与验证码触发
const failCounters = new Map<string, { count: number; resetAt: number }>()
export function trackLoginFailure(username: string): number {
  const now = Date.now()
  const key = "loginfail:" + username.toLowerCase()
  const rec = failCounters.get(key)
  if (!rec || rec.resetAt < now) {
    failCounters.set(key, { count: 1, resetAt: now + 15 * 60_000 })
    return 1
  }
  rec.count += 1
  return rec.count
}
export function clearLoginFailure(username: string) {
  failCounters.delete("loginfail:" + username.toLowerCase())
}
export function getLoginFailure(username: string): number {
  const rec = failCounters.get("loginfail:" + username.toLowerCase())
  if (!rec || rec.resetAt < Date.now()) return 0
  return rec.count
}
