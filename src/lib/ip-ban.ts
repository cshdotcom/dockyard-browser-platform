import { db } from "./db"
import { getConfigBool, getConfigNumber } from "./config"
import { raiseAlert } from "./alerts"
import { writeSecurityEvent } from "./audit"

// ============================================================
// r23：IP 自动封禁（数据库持久化，重启不丢失）
// · 触发源：登录密码错误 / 无效 API-Key 调用（可配置是否计入）
// · 语义：窗口内累计失败次数达到阈值 → 封禁该 IP 一段时间
// · 与 RiskListRule 手工黑名单互补：手工黑名单是永久/手动管理，本表是自动定时封禁
// · 管理员可在后台查看/手动解封/手动封禁（admin-ipban.ts actions）
// · 正常使用不受影响：只有失败才计数；成功登录/有效 Key 调用会清零计数
// ============================================================

export interface IpBanCheck {
  banned: boolean
  ip: string
  bannedUntil?: Date
  remainMinutes?: number
  reason?: string
}

/** 检查 IP 是否处于封禁中（过期自动视作未封禁；记录保留供后台审计查看） */
export async function checkIpBanned(ip: string): Promise<IpBanCheck> {
  const enabled = await getConfigBool("security.ipBanEnabled", true)
  if (!enabled) return { banned: false, ip }
  if (!isRoutableIp(ip)) return { banned: false, ip } // 本机回环/内网探测流量不参与
  const row = await db.ipBanRecord.findUnique({ where: { ip } }).catch(() => null)
  if (!row || !row.bannedUntil) return { banned: false, ip }
  if (row.bannedUntil.getTime() <= Date.now()) return { banned: false, ip }
  return {
    banned: true,
    ip,
    bannedUntil: row.bannedUntil,
    remainMinutes: Math.max(1, Math.ceil((row.bannedUntil.getTime() - Date.now()) / 60_000)),
    reason: row.reason || "连续失败触发自动封禁",
  }
}

/**
 * 记录一次失败并按需触发封禁（达到阈值 → bannedUntil 落库 + 告警）
 * 返回本次记录后的封禁状态（供调用方返回明确的封禁提示）
 */
export async function recordIpLoginFail(ip: string, source: "LOGIN" | "API_KEY", detail: string): Promise<IpBanCheck> {
  const enabled = await getConfigBool("security.ipBanEnabled", true)
  if (!enabled || !isRoutableIp(ip)) return { banned: false, ip }
  const threshold = await getConfigNumber("security.ipBanThreshold", 10)
  const windowMin = await getConfigNumber("security.ipBanWindowMinutes", 15)
  const banMin = await getConfigNumber("security.ipBanMinutes", 30)

  const now = new Date()
  const existing = await db.ipBanRecord.findUnique({ where: { ip } })
  const windowStart = new Date(now.getTime() - windowMin * 60_000)

  // 窗口外旧计数重置；封禁过期后重新计数
  const lastFail = existing?.lastFailAt
  const inWindow = !!lastFail && lastFail.getTime() >= windowStart.getTime() && !(existing?.bannedUntil && existing.bannedUntil.getTime() > now.getTime())
  const prevCount = inWindow ? existing?.failCount ?? 0 : 0
  const count = prevCount + 1

  const shouldBan = count >= threshold
  const bannedUntil = shouldBan ? new Date(now.getTime() + banMin * 60_000) : existing?.bannedUntil ?? null

  await db.ipBanRecord.upsert({
    where: { ip },
    update: {
      failCount: count,
      firstFailAt: inWindow ? existing?.firstFailAt ?? now : now,
      lastFailAt: now,
      bannedUntil,
      source,
      reason: shouldBan ? `窗口内连续失败 ${count} 次（${source}），自动封禁 ${banMin} 分钟` : existing?.reason ?? null,
    },
    create: {
      ip,
      source,
      failCount: count,
      firstFailAt: now,
      lastFailAt: now,
      bannedUntil,
      reason: shouldBan ? `窗口内连续失败 ${count} 次（${source}），自动封禁 ${banMin} 分钟` : null,
    },
  })

  if (shouldBan && !(existing?.bannedUntil && existing.bannedUntil.getTime() > now.getTime())) {
    // 首次跨过阈值才告警（已在封禁中的重复失败不重复告警）
    const alertEnabled = await getConfigBool("security.ipBanAlertEnabled", true)
    if (alertEnabled) {
      await writeSecurityEvent({
        username: null,
        eventType: "IP_BAN_AUTO",
        success: false,
        detail: `IP ${ip} 窗口内连续失败 ${count} 次（${source}），封禁 ${banMin} 分钟。最近原因：${detail.slice(0, 120)}`,
        ip,
      }).catch(() => {})
      await raiseAlert({
        title: `IP 自动封禁：${ip}`,
        level: "ERROR",
        content: `来源IP在 ${windowMin} 分钟内累计失败 ${count} 次（触发源：${source === "LOGIN" ? "登录密码错误" : "无效API-Key"}），已自动封禁 ${banMin} 分钟。最近失败原因：${detail.slice(0, 200)}`,
        resourceType: "SECURITY",
        dedupeKey: `ip-ban-${ip}`,
      }).catch(() => {})
    }
  }

  return {
    banned: shouldBan,
    ip,
    bannedUntil: bannedUntil ?? undefined,
    remainMinutes: shouldBan ? banMin : undefined,
    reason: shouldBan ? "连续失败达到阈值，IP已封禁" : undefined,
  }
}

/** 成功登录 / 有效 Key 调用：清零该 IP 的失败计数（正常使用不受封禁影响） */
export async function clearIpFailCount(ip: string): Promise<void> {
  if (!isRoutableIp(ip)) return
  await db.ipBanRecord.updateMany({
    where: { ip, bannedUntil: null },
    data: { failCount: 0, firstFailAt: null, lastFailAt: null },
  }).catch(() => {})
}

/** 管理员手动封禁（永久=bannedUntil 很远；或指定分钟） */
export async function manualBanIp(ip: string, minutes: number, reason: string, operatorUserId: string, note?: string) {
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : new Date(Date.now() + 100 * 365 * 24 * 3600_000)
  return db.ipBanRecord.upsert({
    where: { ip },
    update: { bannedUntil: until, reason, note, source: "MANUAL", createdByUserId: operatorUserId, unbannedAt: null, unbannedByUserId: null },
    create: { ip, source: "MANUAL", bannedUntil: until, reason, note, createdByUserId: operatorUserId },
  })
}

/** 管理员手动解封 */
export async function manualUnbanIp(ip: string, operatorUserId: string, note?: string) {
  return db.ipBanRecord.update({
    where: { ip },
    data: { bannedUntil: null, failCount: 0, unbannedAt: new Date(), unbannedByUserId: operatorUserId, note },
  })
}

/** 回环/链路本地/私有探测地址不参与封禁（防误伤内部调度与健康探测） */
function isRoutableIp(ip: string): boolean {
  if (!ip) return false
  if (ip === "127.0.0.1" || ip === "::1" || ip === "unknown") return false
  if (ip.startsWith("169.254.") || ip.startsWith("::ffff:127.")) return false
  // Docker 内部网络的自来流量（容器网段）不封禁——外部客户端经网关代理后真实IP在 x-forwarded-for 首位
  if (ip.startsWith("172.1") || ip.startsWith("172.2") || ip.startsWith("172.30.") || ip.startsWith("172.31.")) {
    // 172.16-172.31 私有段：网关注入的真实客户端 IP 优先，此值多为内网网关
    return ip.startsWith("172.16.") || ip.startsWith("172.17.") ? false : false
  }
  return true
}
