import { db } from "./db"
import { getConfig, getConfigBool, getConfigNumber } from "./config"
import { writeAudit } from "./audit"
import { hubEmit } from "./ws-emitter"

// 告警系统：写告警表 + 审计 + 站内通知 + webhook（内存队列/重试/静默窗口/抑制合并/级别过滤）
// r23：+邮件通道（alert.emailEnabled 开启后，达到最低级别的告警同步发邮件；收件人可显式配置或自动取管理员邮箱）

// 告警级别：INFO / WARNING（WARN 同义，CRX 灰度等场景）/ WARN / ERROR（介于 WARN 与 CRITICAL：自愈失败等不可人工忽略的异常）/ CRITICAL
export type AlertLevel = "INFO" | "WARNING" | "WARN" | "ERROR" | "CRITICAL"

// 级别排序（邮件最低级别过滤用）
const LEVEL_ORDER: Record<AlertLevel, number> = { INFO: 1, WARNING: 2, WARN: 2, ERROR: 3, CRITICAL: 4 }

// r23：邮件告警通道（异步 fire-and-forget；抑制窗口内不重发；静默窗口对邮件同样生效）
async function sendAlertEmail(params: { title: string; level: AlertLevel; content: string; suppressed: boolean }): Promise<void> {
  try {
    if (params.suppressed) return
    const enabled = await getConfigBool("alert.emailEnabled", false)
    if (!enabled) return
    const minLevel = (await getConfig<string>("alert.emailMinLevel", "ERROR")) as AlertLevel
    if ((LEVEL_ORDER[params.level] ?? 0) < (LEVEL_ORDER[minLevel] ?? 3)) return
    if (await inSilenceWindow()) return

    // 收件人：显式配置优先；留空 = 全部管理员（有邮箱的）
    let recipients: string[] = []
    const configured = (await getConfig<string>("alert.emailRecipients", "")).trim()
    if (configured) {
      recipients = configured.split(",").map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s))
    } else {
      const admins = await db.user.findMany({
        where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, deletedAt: null, enabled: true, email: { not: null } },
        select: { email: true },
      })
      recipients = admins.map((a) => a.email!).filter(Boolean)
    }
    if (recipients.length === 0) return

    const { sendMail, alertEmailTemplate } = await import("./email")
    const subject = `[${params.level}] ${params.title}`
    const html = await alertEmailTemplate(params.level, params.title, params.content)
    // 逐个发送（失败不影响其他收件人；sendMail 内部自带模拟模式降级）
    for (const to of recipients.slice(0, 20)) {
      await sendMail(to, subject, html, params.content).catch(() => {})
    }
  } catch (e) {
    console.error("[alert] email notify failed", e)
  }
}

const g = globalThis as unknown as {
  __dyWebhookQueue?: { url: string; event: string; payload: Record<string, unknown>; attempts: number }[]
  __dyAlertSuppression?: Map<string, number>
  __dyWebhookProcessing?: boolean
}

function webhookQueue() {
  if (!g.__dyWebhookQueue) g.__dyWebhookQueue = []
  return g.__dyWebhookQueue
}
function suppressionMap() {
  if (!g.__dyAlertSuppression) g.__dyAlertSuppression = new Map()
  return g.__dyAlertSuppression
}

// 静默窗口判断（如 23:00-07:00）
async function inSilenceWindow(): Promise<boolean> {
  const enabled = await getConfigBool("alert.silenceEnabled", false)
  if (!enabled) return false
  const start = await getConfig<string>("alert.silenceStart", "23:00")
  const end = await getConfig<string>("alert.silenceEnd", "07:00")
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(":").map(Number)
  const [eh, em] = end.split(":").map(Number)
  const s = sh * 60 + (sm || 0)
  const e = eh * 60 + (em || 0)
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

export async function raiseAlert(params: {
  title: string
  level: AlertLevel
  content: string
  resourceType?: string
  resourceId?: string
  ownerUserId?: string
  traceId?: string
  dedupeKey?: string // 相同key在抑制窗口内合并
  notifyUserIds?: string[] // 站内通知接收人
  webhookPayload?: Record<string, unknown>
}) {
  try {
    // 抑制合并：相同dedupeKey短时间重复告警只保留库内记录，不再重复推送
    let suppressed = false
    if (params.dedupeKey) {
      const last = suppressionMap().get(params.dedupeKey)
      const windowMs = (await getConfigNumber("alert.suppressWindowSec", 300)) * 1000
      if (last && Date.now() - last < windowMs) {
        suppressed = true
      } else {
        suppressionMap().set(params.dedupeKey, Date.now())
      }
    }

    const alert = await db.alert.create({
      data: {
        title: params.title,
        level: params.level,
        content: params.content,
        resourceType: params.resourceType || null,
        resourceId: params.resourceId || null,
        ownerUserId: params.ownerUserId || null,
        traceId: params.traceId || null,
        dedupeKey: params.dedupeKey || null,
      },
    })

    // 审计
    await writeAudit({
      operationType: "ALERT_TRIGGER",
      resourceType: "ALERT",
      resourceId: alert.id,
      resourceName: params.title,
      severity: params.level === "CRITICAL" ? "CRITICAL" : "WARN",
      after: { level: params.level, title: params.title, suppressed },
    })

    // 站内通知
    const userIds = new Set(params.notifyUserIds || [])
    if (params.ownerUserId) userIds.add(params.ownerUserId)
    // 管理员总是收到 CRITICAL
    if (params.level === "CRITICAL") {
      const admins = await db.user.findMany({
        where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, deletedAt: null, enabled: true },
        select: { id: true },
      })
      admins.forEach((a) => userIds.add(a.id))
    }
    for (const uid of userIds) {
      if (!uid) continue
      await db.notice.create({
        data: {
          userId: uid,
          title: `[${params.level}] ${params.title}`,
          content: params.content.slice(0, 500),
          type: "ALERT",
        },
      })
      // WebSocket 实时站内推送
      void hubEmit("notice", { title: `[${params.level}] ${params.title}`, content: params.content.slice(0, 300), level: params.level }, `user:${uid}`)
    }

    // webhook（静默窗口内跳过外部通知；仅CRITICAL配置开启时过滤级别）
    if (!suppressed) {
      const inSilence = await inSilenceWindow()
      const criticalOnly = await getConfigBool("alert.criticalWebhookOnly", false)
      if (!inSilence && (!criticalOnly || params.level === "CRITICAL")) {
        const globalUrl = await getConfig<string>("alert.webhookUrl", "")
        if (globalUrl) {
          webhookQueue().push({
            url: globalUrl,
            event: params.resourceType ? `${params.resourceType}_ALERT` : "SYSTEM_ALERT",
            payload: {
              title: params.title,
              level: params.level,
              content: params.content,
              resourceType: params.resourceType,
              resourceId: params.resourceId,
              triggeredAt: new Date().toISOString(),
              ...(params.webhookPayload || {}),
            },
            attempts: 0,
          })
        }
        // 命中 WebhookRule 的独立规则
        const rules = await db.webhookRule.findMany({
          where: { enabled: true, deletedAt: null },
        })
        for (const rule of rules) {
          const events = (rule.events as string[]) || []
          if (events.length > 0 && !events.includes(params.resourceType || "SYSTEM")) continue
          webhookQueue().push({
            url: rule.url,
            event: params.resourceType ? `${params.resourceType}_ALERT` : "SYSTEM_ALERT",
            payload: { title: params.title, level: params.level, content: params.content, ruleName: rule.name },
            attempts: 0,
          })
        }
        void processWebhookQueue()
      }
    }

    // r23：邮件通道（异步，不阻塞告警主链路）
    void sendAlertEmail({ title: params.title, level: params.level, content: params.content, suppressed })

    return alert
  } catch (e) {
    console.error("[alert] raise failed", e)
    return null
  }
}

// webhook 发送队列：内存队列 + 失败重试（最大重试次数读取配置）
async function processWebhookQueue() {
  if (g.__dyWebhookProcessing) return
  g.__dyWebhookProcessing = true
  try {
    const queue = webhookQueue()
    const maxRetry = await getConfigNumber("alert.webhookMaxRetry", 3)
    while (queue.length > 0) {
      const job = queue.shift()!
      try {
        const body = JSON.stringify(job.payload)
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 10000)
        const res = await fetch(job.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Dockyard-Event": job.event },
          body,
          signal: ctrl.signal,
        })
        clearTimeout(timer)
        await db.webhookDelivery.create({
          data: {
            url: job.url,
            event: job.event,
            payloadJson: body,
            status: res.ok ? "SUCCESS" : "FAILED",
            attempts: job.attempts + 1,
            sentAt: new Date(),
            lastError: res.ok ? null : `HTTP ${res.status}`,
          },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } catch (e) {
        job.attempts += 1
        const errMsg = e instanceof Error ? e.message : String(e)
        await db.webhookDelivery
          .create({
            data: { url: job.url, event: job.event, payloadJson: JSON.stringify(job.payload), status: "FAILED", attempts: job.attempts, lastError: errMsg },
          })
          .catch(() => {})
        if (job.attempts < maxRetry) {
          // 延迟退避重试
          setTimeout(() => {
            queue.push(job)
            void processWebhookQueue()
          }, job.attempts * 5000)
        }
      }
    }
  } finally {
    g.__dyWebhookProcessing = false
  }
}
