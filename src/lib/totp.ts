import { generateSecret, verifySync, generateURI } from "otplib"
import crypto from "crypto"
import { encrypt, decrypt, generateBackupCodes, sha256, safeEqual } from "./crypto"
import { db } from "./db"

// TOTP 双因素认证（otplib v13 API）：密钥 AES-256-GCM 加密落盘；备份码哈希存储
// 容忍时钟偏差：前后各30秒（epochTolerance=30 → 实际为±1个30s窗口）

export function generateTotpSecret(): string {
  return generateSecret({ length: 20 })
}

export function totpOtpauthUrl(secret: string, account: string, issuer = "Dockyard") {
  return generateURI({ strategy: "totp", issuer, label: account, secret, digits: 6, period: 30 })
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    const result = verifySync({
      secret,
      token: token.replace(/\s/g, ""),
      strategy: "totp",
      epochTolerance: 30,
    })
    return result.valid === true
  } catch {
    return false
  }
}

// ---- 用户 TOTP 密钥管理（加密存取） ----

export async function saveTotpSecret(userId: string, secret: string, confirmed: boolean) {
  const enc = encrypt(secret)
  await db.totpSecret.upsert({
    where: { userId },
    update: { secretEncrypted: enc, confirmed },
    create: { userId, secretEncrypted: enc, confirmed },
  })
}

export async function getTotpSecret(userId: string): Promise<string | null> {
  const row = await db.totpSecret.findUnique({ where: { userId } })
  if (!row) return null
  try {
    return decrypt(row.secretEncrypted)
  } catch {
    return null
  }
}

export async function deleteTotpSecret(userId: string) {
  await db.totpSecret.deleteMany({ where: { userId } })
}

// ---- 备份恢复码（10组一次性） ----

export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  await db.twoFactorBackupCode.deleteMany({ where: { userId } })
  const codes = generateBackupCodes(10)
  await Promise.all(
    codes.map((c) =>
      db.twoFactorBackupCode.create({
        data: { userId, codeHash: sha256(c) },
      })
    )
  )
  return codes
}

export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const rows = await db.twoFactorBackupCode.findMany({
    where: { userId, usedAt: null },
    take: 20,
  })
  for (const row of rows) {
    if (safeEqual(sha256(code.trim().toUpperCase()), row.codeHash)) {
      await db.twoFactorBackupCode.update({ where: { id: row.id }, data: { usedAt: new Date() } })
      return true
    }
  }
  return false
}

export async function countUnusedBackupCodes(userId: string): Promise<number> {
  return db.twoFactorBackupCode.count({ where: { userId, usedAt: null } })
}

// HMAC 签名（webhook）
export function hmacSign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex")
}
