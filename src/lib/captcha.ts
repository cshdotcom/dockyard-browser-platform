import crypto from "crypto"

// 图形验证码：服务端内存存储（5分钟过期自动清理），答案不返回前端
const g = globalThis as unknown as { __dyCaptcha?: Map<string, { answer: string; expiresAt: number }> }

function store() {
  if (!g.__dyCaptcha) {
    g.__dyCaptcha = new Map()
    const cleaner = setInterval(() => {
      const now = Date.now()
      for (const [k, v] of g.__dyCaptcha!) if (v.expiresAt < now) g.__dyCaptcha!.delete(k)
    }, 60_000)
    ;(cleaner as unknown as { unref?: () => void }).unref?.()
  }
  return g.__dyCaptcha
}

// 简易数学验证码：a + b = ?
export function generateCaptcha(): { id: string; svg: string; expiresAt: number } {
  const a = crypto.randomInt(1, 20)
  const b = crypto.randomInt(1, 20)
  const answer = String(a + b)
  const id = crypto.randomUUID()
  const expiresAt = Date.now() + 5 * 60_000
  store().set(id, { answer, expiresAt })
  const noise = Array.from({ length: 3 }, () => `M${crypto.randomInt(0, 160)} ${crypto.randomInt(0, 40)} Q${crypto.randomInt(0, 160)} ${crypto.randomInt(0, 40)} ${crypto.randomInt(0, 160)} ${crypto.randomInt(0, 40)}`).join(" ")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40" viewBox="0 0 160 40"><rect width="160" height="40" fill="#f0fdfa" rx="6"/><path d="${noise}" stroke="#99f6e4" fill="none" stroke-width="2"/><text x="55" y="27" font-family="monospace" font-size="20" font-weight="700" fill="#0f766e" text-anchor="middle" transform="rotate(${crypto.randomInt(-4, 5)} 80 20)">${a}+${b}=?</text></svg>`
  return { id, svg, expiresAt }
}

export function verifyCaptcha(id: string, code: string): boolean {
  const rec = store().get(id)
  if (!rec || rec.expiresAt < Date.now()) return false
  const ok = rec.answer === code.trim()
  if (ok) store().delete(id)
  return ok
}
