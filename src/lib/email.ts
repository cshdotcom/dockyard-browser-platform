import nodemailer from "nodemailer"
import { ENV, externalAvailable } from "./env"
import { getConfig, ensureConfigLoaded } from "./config"
import { decrypt, encrypt } from "./crypto"

// 邮件服务适配器（SMTP 服务器后台可改）：
//   优先级：后台 SystemConfig（smtp.* 配置项，管理员可随时修改，30s 热生效）→ ENV 环境变量 → 未配置进入控制台模拟模式
//   密码 AES 加密落库（smtp.pass 存 encrypt() 密文），读取时解密；模拟模式保持开发/演示链路完整可跑

let cachedTransporter: nodemailer.Transporter | null = null
let cachedAt = 0
let cachedKey = ""

export interface SmtpRuntimeConfig {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  user: string
  pass: string // 运行时解密后的明文（仅内存，绝不返回前端）
  from: string
  senderName: string
  source: "db" | "env" | "none"
}

// 读取生效 SMTP 配置（DB 优先；DB 未启用时回退 ENV）
export async function resolveSmtpConfig(): Promise<SmtpRuntimeConfig> {
  await ensureConfigLoaded().catch(() => { /* DB 不可用时降级 ENV */ })
  try {
    const [enabled, host, port, secure, user, passEnc, from, senderName] = await Promise.all([
      getConfig<boolean>("smtp.enabled", false),
      getConfig<string>("smtp.host", ""),
      getConfig<number>("smtp.port", 465),
      getConfig<boolean>("smtp.secure", true),
      getConfig<string>("smtp.user", ""),
      getConfig<string>("smtp.pass", ""),
      getConfig<string>("smtp.from", ""),
      getConfig<string>("smtp.senderName", "Dockyard 平台"),
    ])
    if (enabled && host) {
      let pass = ""
      if (passEnc) {
        try { pass = decrypt(passEnc) } catch { pass = passEnc /* 兼容历史明文 */ }
      }
      return { enabled: true, host, port, secure, user, pass, from: from || user, senderName, source: "db" }
    }
  } catch { /* 读取失败回退 ENV */ }
  if (externalAvailable.smtp && ENV.smtpHost) {
    return {
      enabled: true, host: ENV.smtpHost, port: ENV.smtpPort, secure: ENV.smtpPort === 465,
      user: ENV.smtpUser, pass: ENV.smtpPass, from: ENV.smtpFrom || ENV.smtpUser, senderName: "Dockyard 平台", source: "env",
    }
  }
  return { enabled: false, host: "", port: 465, secure: true, user: "", pass: "", from: "", senderName: "", source: "none" }
}

function transportKey(c: SmtpRuntimeConfig): string {
  // 密码参与缓存键（改密码立即失效重建）
  return `${c.source}|${c.host}|${c.port}|${c.secure}|${c.user}|${c.pass.length}|${shaLite(c.pass)}`
}
function shaLite(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  const cfg = await resolveSmtpConfig()
  if (!cfg.enabled || !cfg.host) return null
  const key = transportKey(cfg)
  if (cachedTransporter && cachedKey === key && Date.now() - cachedAt < 30_000) return cachedTransporter
  try { cachedTransporter?.close() } catch { /* noop */ }
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  cachedAt = Date.now()
  cachedKey = key
  return cachedTransporter
}

// 清空缓存（配置保存后调用，立即生效）
export function invalidateSmtpCache() {
  cachedTransporter = null
  cachedKey = ""
  cachedAt = 0
}

export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<{ sent: boolean; simulated: boolean; source: "db" | "env" | "none" }> {
  const cfg = await resolveSmtpConfig()
  const t = await getTransporter()
  if (!t) {
    console.log(`[mail:simulated] to=${to} subject=${subject}`)
    return { sent: true, simulated: true, source: "none" }
  }
  try {
    await t.sendMail({
      from: cfg.senderName ? `"${cfg.senderName}" <${cfg.from}>` : cfg.from,
      to,
      subject,
      html,
      text: text || subject,
    })
    return { sent: true, simulated: false, source: cfg.source }
  } catch (e) {
    console.error("[mail] send failed", e)
    return { sent: false, simulated: false, source: cfg.source }
  }
}

// SMTP 连接验证（后台"测试连接"按钮）：真实 SMTP 握手 + 可选发送测试邮件
export async function verifySmtpConnection(to?: string): Promise<{ ok: boolean; verified: boolean; sent: boolean; message: string; source: string }> {
  const cfg = await resolveSmtpConfig()
  if (!cfg.enabled || !cfg.host) {
    return { ok: false, verified: false, sent: false, message: "SMTP 未启用或未配置服务器地址（当前为控制台模拟模式）", source: cfg.source }
  }
  const t = await getTransporter()
  if (!t) return { ok: false, verified: false, sent: false, message: "传输器创建失败", source: cfg.source }
  try {
    await t.verify()
  } catch (e) {
    return { ok: false, verified: false, sent: false, message: `连接失败（使用已保存配置 ${cfg.host}:${cfg.port} ${cfg.secure ? "SSL" : "STARTTLS"}）：${e instanceof Error ? e.message : String(e)}`, source: cfg.source }
  }
  if (!to) return { ok: true, verified: true, sent: false, message: `SMTP 连接成功（${cfg.host}:${cfg.port} ${cfg.secure ? "SSL" : "STARTTLS"} · 认证${cfg.user ? "已启用" : "未启用"}）`, source: cfg.source }
  try {
    await t.sendMail({
      from: cfg.senderName ? `"${cfg.senderName}" <${cfg.from}>` : cfg.from,
      to,
      subject: "【Dockyard】SMTP 测试邮件",
      html: smtpTestTemplate(),
      text: "Dockyard SMTP 配置测试成功",
    })
    return { ok: true, verified: true, sent: true, message: `连接成功且测试邮件已发送至 ${to}`, source: cfg.source }
  } catch (e) {
    return { ok: false, verified: true, sent: false, message: `握手成功但发送失败（${cfg.host}:${cfg.port}）：${e instanceof Error ? e.message : String(e)}`, source: cfg.source }
  }
}

export function smtpTestTemplate(): string {
  return `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
    <h2 style="color:#0f766e;margin:0 0 12px">SMTP 配置测试成功</h2>
    <p style="color:#374151;margin:0">您在 Dockyard 后台配置的邮件服务器工作正常。配置修改即时生效（30 秒内），验证码 / 告警邮件将经由该服务器发送。</p>
    <p style="color:#6b7280;font-size:12px;margin:16px 0 0">发送时间：${new Date().toLocaleString("zh-CN")}</p>
  </div>`
}

export function emailCodeTemplate(code: string, purpose: string): string {
  const purposeText: Record<string, string> = {
    LOGIN: "登录验证码",
    REGISTER: "账号激活验证码",
    RESET_PASSWORD: "重置密码验证码",
    CHANGE_EMAIL_OLD: "换绑邮箱确认（原邮箱）",
    CHANGE_EMAIL_NEW: "换绑邮箱确认（新邮箱）",
  }
  return `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
    <h2 style="color:#0f766e;margin:0 0 12px">Dockyard 浏览器工作平台</h2>
    <p style="color:#374151;margin:0 0 16px">您的${purposeText[purpose] || "验证码"}：</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0f766e;background:#f0fdfa;padding:12px 20px;border-radius:8px;text-align:center">${code}</div>
    <p style="color:#6b7280;font-size:12px;margin:16px 0 0">验证码一次性使用，请勿泄露给他人。如非本人操作请立即修改密码。</p>
  </div>`
}

export function remoteLoginAlertTemplate(ip: string, ua: string, time: string): string {
  return `
  <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
    <h2 style="color:#b45309;margin:0 0 12px">异地登录风险提醒</h2>
    <p>检测到您的账号在新的 IP 地址登录：</p>
    <ul style="color:#374151">
      <li>时间：${time}</li>
      <li>IP：${ip}</li>
      <li>设备：${ua.slice(0, 120)}</li>
    </ul>
    <p style="color:#6b7280;font-size:12px;margin:16px 0 0">如非本人操作，请立即修改密码并检查登录设备列表。</p>
  </div>`
}

// r23：告警邮件模板（预警中心邮件通道）
export function alertEmailTemplate(level: string, title: string, content: string): string {
  const tone = level === "CRITICAL" ? "#b91c1c" : level === "ERROR" ? "#c2410c" : "#0f766e"
  const label = level === "CRITICAL" ? "严重告警" : level === "ERROR" ? "错误告警" : "平台告警"
  return `
  <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
    <h2 style="color:${tone};margin:0 0 12px">【${label}】Dockyard 平台预警通知</h2>
    <div style="font-size:16px;font-weight:600;color:#111827;margin-bottom:8px">${escapeHtml(title)}</div>
    <div style="color:#374151;background:#f9fafb;padding:12px 16px;border-radius:8px;white-space:pre-wrap;word-break:break-word">${escapeHtml(content)}</div>
    <p style="color:#6b7280;font-size:12px;margin:16px 0 0">触发时间：${new Date().toLocaleString("zh-CN")} · 本邮件由平台预警中心自动发送，可在 后台 → 配置 → 预警中心 调整级别与收件人。</p>
  </div>`
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// 加密工具导出（配置保存动作用）
export { encrypt as encryptSmtpPassword }
