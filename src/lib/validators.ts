import { z } from "zod"
import { db } from "./db"
import { ErrorCode, BizError } from "./errors"

// 密码复杂度校验（规则从 system_config 读取）
export async function validatePasswordPolicy(password: string): Promise<{ ok: boolean; message?: string }> {
  const { getConfig, getConfigNumber, getConfigBool } = await import("./config")
  const minLen = await getConfigNumber("security.passwordMinLength", 8)
  if (password.length < minLen) return { ok: false, message: `密码长度不能少于${minLen}位` }
  const needUpper = await getConfigBool("security.passwordRequireUpper", true)
  const needLower = await getConfigBool("security.passwordRequireLower", true)
  const needDigit = await getConfigBool("security.passwordRequireDigit", true)
  const needSpecial = await getConfigBool("security.passwordRequireSpecial", false)
  if (needUpper && !/[A-Z]/.test(password)) return { ok: false, message: "密码必须包含大写字母" }
  if (needLower && !/[a-z]/.test(password)) return { ok: false, message: "密码必须包含小写字母" }
  if (needDigit && !/[0-9]/.test(password)) return { ok: false, message: "密码必须包含数字" }
  if (needSpecial && !/[^A-Za-z0-9]/.test(password)) return { ok: false, message: "密码必须包含特殊符号" }
  const banWeak = await getConfigBool("security.passwordBanWeakDict", true)
  if (banWeak && WEAK_PASSWORDS.includes(password.toLowerCase())) {
    return { ok: false, message: "密码强度过弱（命中弱密码字典）" }
  }
  return { ok: true }
}

const WEAK_PASSWORDS = [
  "123456", "12345678", "123456789", "password", "password1", "admin123", "admin888",
  "qwerty", "qwerty123", "111111", "888888", "666666", "abc123", "letmein", "welcome",
  "monkey", "dragon", "iloveyou", "sunshine", "princess", "football", "000000", "123qwe",
]

// 历史密码复用检查
export async function checkPasswordHistory(userId: string, newPassword: string): Promise<boolean> {
  const { getConfigNumber } = await import("./config")
  const n = await getConfigNumber("security.passwordHistoryCount", 5)
  if (n <= 0) return true
  const { hashPassword } = await import("./crypto")
  const histories = await db.passwordHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: n,
  })
  const current = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } })
  const candidates = [...histories.map((h) => h.passwordHash), current?.passwordHash].filter(Boolean) as string[]
  const { default: bcrypt } = await import("bcryptjs")
  for (const hash of candidates) {
    if (await bcrypt.compare(newPassword, hash)) return false
  }
  return true
}

// ---- 通用 zod schema ----
export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
})

export const zId = z.string().min(1).max(64)
export const zEmail = z.string().email().max(190)
export const zUsername = z
  .string()
  .min(3, "用户名至少3位")
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "用户名仅允许字母数字下划线点横线")

// 0.001 精度数值输入校验（全后端统一）
export const zPrecision = (label: string, min = 0, max = 1e12) =>
  z.coerce
    .number()
    .refine((v) => Number.isFinite(v), `${label}必须为数值`)
    .refine((v) => v >= min, `${label}不能小于${min}`)
    .refine((v) => v <= max, `${label}不能大于${max}`)
    .transform((v) => Math.round(v * 1000) / 1000)

export function zodValidate<T>(schema: z.ZodType<T>, input: unknown): T {
  const res = schema.safeParse(input)
  if (!res.success) {
    const first = res.error.issues[0]
    throw new BizError(ErrorCode.PARAM_ERROR, first?.message || "参数校验失败")
  }
  return res.data
}
