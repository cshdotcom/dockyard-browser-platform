import crypto from "crypto"
import bcrypt from "bcryptjs"
import { ENV } from "./env"

// AES-256-GCM 加解密：TOTP密钥 / 代理密码 / NoVNC临时密钥 全程加密落盘
const ALGO = "aes-256-gcm"

function key32() {
  const k = ENV.encryptionKey
  return crypto.createHash("sha256").update(String(k)).digest() // 统一32字节
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key32(), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":")
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":")
  const decipher = crypto.createDecipheriv(ALGO, key32(), Buffer.from(ivB64, "base64"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8")
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex")
}

// 高熵 API Token：明文仅返回一次，库内只存哈希
export function generateApiToken(): string {
  return "dy_" + crypto.randomBytes(32).toString("hex")
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

// 时间恒定比较（防时序攻击）
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) {
    // 长度不同也做一次比较运算，抹平时序
    bcrypt.compareSync(a, "$2a$12$C6UzMDM.H6dfI/f/IKcEe.PjOAiLm5.qY1KOdDT0HkYf0Y1vzOkSy")
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

// 6位数字验证码
export function randomDigits(len = 6): string {
  let out = ""
  for (let i = 0; i < len; i++) out += crypto.randomInt(0, 10).toString()
  return out
}

// 一次性备份恢复码（10组，格式 XXXX-XXXX）
export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString("hex").toUpperCase()
    codes.push(raw.slice(0, 4) + "-" + raw.slice(4, 8))
  }
  return codes
}

// 设备指纹：UA + IP 摘要（不存明文IP，防隐私问题同时能识别设备）
export function deviceFingerprint(ua: string, ip: string): string {
  return sha256(ua + "|" + ip).slice(0, 32)
}

export function maskSensitive(obj: Record<string, unknown>, keys: string[] = ["password", "secret", "token", "passwordEnc", "novncSecret", "apiKey"]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = keys.some((kk) => k.toLowerCase().includes(kk.toLowerCase())) ? "******" : v
  }
  return out
}
