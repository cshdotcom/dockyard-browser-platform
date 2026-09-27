// 全局统一错误码体系（部分核心错误码，业务模块可扩展）
export const ErrorCode = {
  OK: 0,
  PARAM_ERROR: 40001,
  UNAUTHORIZED: 40100,
  FORBIDDEN: 40300,
  NOT_FOUND: 40400,
  CONFLICT: 40900,
  RATE_LIMITED: 42900,
  IDEMPOTENT_REJECT: 42901,
  MAINTENANCE: 50300,
  INTERNAL: 50000,
  // 业务错误码
  USER_LOCKED: 41001,
  BAD_CREDENTIALS: 41002,
  EMAIL_NOT_VERIFIED: 41003,
  TWO_FACTOR_REQUIRED: 41004,
  TWO_FACTOR_INVALID: 41005,
  CAPTCHA_REQUIRED: 41006,
  TOKEN_EXPIRED: 41101,
  QUOTA_EXCEEDED: 42001,
  RESOURCE_IN_USE: 42002,
  RECYCLE_LOCKED: 43001,
  RECYCLE_EXPIRED: 43002,
  PERMISSION_LOCKED: 43100,
  EXTERNAL_SERVICE: 45001,
  RISK_BLOCKED: 46001,
  IDEMPOTENT_ERROR: 47001,
} as const

export type CodeType = (typeof ErrorCode)[keyof typeof ErrorCode]

export class BizError extends Error {
  code: number
  detail?: string
  constructor(code: number, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

export function bizError(code: number, message: string, detail?: string) {
  return new BizError(code, message, detail)
}
