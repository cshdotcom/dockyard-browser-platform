import { db } from "./db"
import { getRequestMeta } from "./trace"
import { maskSensitive } from "./crypto"

// 审计日志统一封装：全后端唯一入口，只允许 INSERT，禁止任何 update/delete 调用路径
export interface AuditParams {
  operatorUserId?: string | null
  operatorName?: string | null
  operationType: string // LOGIN | USER_CREATE | USER_UPDATE | ...
  resourceType: string // USER | GROUP | WORKSPACE | SINGBOX | TOKEN | CONFIG | ...
  resourceId?: string | null
  resourceName?: string | null
  ownerUserId?: string | null
  createdByUserId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  severity?: "INFO" | "WARN" | "CRITICAL" | "DANGER"
  extra?: Record<string, unknown> | null
  ip?: string
  userAgent?: string
  traceId?: string
}

export async function writeAudit(params: AuditParams) {
  try {
    let ip = params.ip
    let ua = params.userAgent
    let traceId = params.traceId
    if (!ip || !ua) {
      try {
        const meta = await getRequestMeta()
        ip = ip || meta.ip
        ua = ua || meta.ua
        traceId = traceId || meta.traceId
      } catch {
        // 非 request 上下文（定时任务）—— 使用传入值
      }
    }
    await db.auditLog.create({
      data: {
        traceId: traceId || null,
        operatorUserId: params.operatorUserId || null,
        operatorName: params.operatorName || null,
        operationType: params.operationType,
        resourceType: params.resourceType,
        resourceId: params.resourceId || null,
        resourceName: params.resourceName || null,
        ownerUserId: params.ownerUserId || null,
        createdByUserId: params.createdByUserId || null,
        clientIp: ip || null,
        userAgent: ua || null,
        severity: params.severity || "INFO",
        beforeJson: params.before ? JSON.stringify(maskSensitive(params.before)) : null,
        afterJson: params.after ? JSON.stringify(maskSensitive(params.after)) : null,
        extraJson: params.extra ? JSON.stringify(maskSensitive(params.extra)) : null,
      },
    })
  } catch (e) {
    console.error("[audit] write failed", e)
  }
}

// 安全事件（用户可见的安全日志）：登录成功/失败、2FA、密码修改、邮箱变更、设备下线等
export async function writeSecurityEvent(params: {
  userId?: string | null
  username?: string | null
  eventType: string
  success?: boolean
  detail?: string
  ip?: string
  userAgent?: string
  traceId?: string
}) {
  try {
    let ip = params.ip
    let ua = params.userAgent
    let traceId = params.traceId
    if (!ip || !ua) {
      try {
        const meta = await getRequestMeta()
        ip = ip || meta.ip
        ua = ua || meta.ua
        traceId = traceId || meta.traceId
      } catch { /* 定时任务上下文 */ }
    }
    await db.securityEvent.create({
      data: {
        userId: params.userId || null,
        username: params.username || null,
        eventType: params.eventType,
        success: params.success ?? true,
        detail: params.detail?.slice(0, 500) || null,
        ip: ip || null,
        userAgent: ua || null,
        traceId: traceId || null,
      },
    })
  } catch (e) {
    console.error("[security-event] write failed", e)
  }
}
