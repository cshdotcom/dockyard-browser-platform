import nodemailer from "nodemailer"
import { ENV, externalAvailable } from "./env"

// 邮件服务适配器：SMTP 配置存在走真实发送；未配置进入控制台模拟模式（开发/演示链路完整可跑）
let cachedTransporter: nodemailer.Transporter | null = null

function getTransporter(): nodemailer.Transporter | null {
  if (!externalAvailable.smtp) return null
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: ENV.smtpHost,
      port: ENV.smtpPort,
      secure: ENV.smtpPort === 465,
      auth: ENV.smtpUser ? { user: ENV.smtpUser, pass: ENV.smtpPass } : undefined,
    })
  }
  return cachedTransporter
}

export async function sendMail(to: string, subject: string, html: string, text?: string): Promise<{ sent: boolean; simulated: boolean }> {
  const t = getTransporter()
  if (!t) {
    console.log(`[mail:simulated] to=${to} subject=${subject}`)
    return { sent: true, simulated: true }
  }
  try {
    await t.sendMail({
      from: ENV.smtpFrom,
      to,
      subject,
      html,
      text: text || subject,
    })
    return { sent: true, simulated: false }
  } catch (e) {
    console.error("[mail] send failed", e)
    return { sent: false, simulated: false }
  }
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
    <p style="color:#6b7280;font-size:12px">如非本人操作，请立即修改密码并检查登录设备列表。</p>
  </div>`
}
