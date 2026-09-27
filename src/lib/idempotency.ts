import { db } from "./db"
import { sha256 } from "./crypto"

// 幂等防护：用户ID+操作类型+时间指纹；短时间重复提交直接拦截
// 键窗口内的重复请求返回首次结果

export async function idempotencyCheck(userId: string, action: string, payload: unknown, windowMs = 10_000) {
  const fingerprint = sha256(`${userId}|${action}|${JSON.stringify(payload ?? null)}`)
  const existing = await db.idempotencyRecord.findFirst({
    where: { fingerprint, expiresAt: { gt: new Date() } },
  })
  if (existing) {
    return { repeated: true, fingerprint, previousResult: existing.resultJson ? JSON.parse(existing.resultJson) : null }
  }
  await db.idempotencyRecord.create({
    data: {
      fingerprint,
      userId,
      action,
      expiresAt: new Date(Date.now() + windowMs),
    },
  })
  return { repeated: false, fingerprint, previousResult: null }
}

export async function idempotencyComplete(fingerprint: string, result: unknown) {
  await db.idempotencyRecord.updateMany({
    where: { fingerprint },
    data: { resultJson: JSON.stringify(result ?? null) },
  })
}

// 清理过期幂等记录（定时任务调用）
export async function cleanIdempotencyRecords() {
  const res = await db.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return res.count
}
