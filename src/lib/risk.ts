import { db } from "./db"
import { raiseAlert } from "./alerts"

// 风控底座：IP/UA/设备 黑白名单校验 + 用户行为异常检测（防刷资源）
// 黑名单：全站生效（登录/API/MCP/VNC/WebSocket 全部拦截）
// 白名单：仅外部通道（API-Key 调用 /api/mcp、/api/openapi、VNC 代理）强制，网页登录不受白名单限制

export async function checkIpBlack(ip: string): Promise<{ blocked: boolean; reason?: string }> {
  const rules = await db.riskListRule.findMany({
    where: { type: "IP_BLACK", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  })
  if (matchList(ip, rules.map((r) => r.value))) {
    return { blocked: true, reason: "IP黑名单" }
  }
  return { blocked: false }
}

export async function checkIpRisk(ip: string): Promise<{ blocked: boolean; whiteListMode: boolean; reason?: string }> {
  const black = await checkIpBlack(ip)
  if (black.blocked) return { blocked: true, whiteListMode: false, reason: black.reason }
  const whiteRules = await db.riskListRule.findMany({
    where: { type: "IP_WHITE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  })
  if (whiteRules.length > 0 && !matchList(ip, whiteRules.map((r) => r.value))) {
    return { blocked: true, whiteListMode: true, reason: "IP白名单模式下该IP不可访问" }
  }
  return { blocked: false, whiteListMode: whiteRules.length > 0 }
}

export async function checkUaRisk(ua: string): Promise<boolean> {
  const rules = await db.riskListRule.findMany({
    where: { type: "UA_BLACK", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  })
  return rules.some((r) => ua.toLowerCase().includes(r.value.toLowerCase()))
}

function matchList(ip: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.includes("/")) {
      // CIDR 段匹配（简单IPv4实现）
      return ipInCidr(ip, p)
    }
    if (p.includes("*")) {
      const regex = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]") + "$")
      return regex.test(ip)
    }
    return p === ip
  })
}

function ipInCidr(ip: string, cidr: string): boolean {
  try {
    const [base, bitsStr] = cidr.split("/")
    const bits = Number(bitsStr)
    const toInt = (s: string) => s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0)
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
    return (toInt(ip) & mask) === (toInt(base) & mask)
  } catch {
    return false
  }
}

// 行为画像更新（每类操作调用）
export async function trackBehavior(userId: string, kind: "CREATE" | "DELETE" | "RESTORE" | "MCP_CALL" | "VNC_MIN" | "BATCH" | "RISK") {
  const inc: Record<string, number> = {}
  if (kind === "CREATE") inc.resourcesCreated = 1
  if (kind === "DELETE") inc.resourcesDeleted = 1
  if (kind === "RESTORE") inc.resourcesRestored = 1
  if (kind === "MCP_CALL") inc.mcpCalls = 1
  if (kind === "BATCH") inc.batchOps = 1
  if (kind === "RISK") inc.riskTriggers = 1
  if (kind === "VNC_MIN") inc.vncDurationMin = 0.0167
  await db.userBehaviorProfile.upsert({
    where: { userId },
    update: { ...inc, updatedAt: new Date() },
    create: { userId, ...inc },
  })
}

// 异常行为检测：短时间高频创建/销毁、批量导入导出、多IP同时登录
const g = globalThis as unknown as { __dyBehavior?: Map<string, { createTimes: number[]; deleteTimes: number[] }> }
function behavior() {
  if (!g.__dyBehavior) g.__dyBehavior = new Map()
  return g.__dyBehavior
}

export async function detectAbnormalBehavior(userId: string, action: "WORKSPACE_CREATE" | "WORKSPACE_DELETE" | "INSTANCE_TOGGLE" | "IMPORT_EXPORT"): Promise<{ abnormal: boolean; detail?: string }> {
  const rec = behavior().get(userId) || { createTimes: [], deleteTimes: [] }
  const now = Date.now()
  if (action === "WORKSPACE_CREATE") {
    rec.createTimes.push(now)
    rec.createTimes = rec.createTimes.filter((t) => now - t < 60_000)
    behavior().set(userId, rec)
    if (rec.createTimes.length >= 10) {
      await flagAbnormal(userId, `1分钟内创建${rec.createTimes.length}个工作区`)
      return { abnormal: true, detail: "创建频率过高" }
    }
  }
  if (action === "WORKSPACE_DELETE" || action === "INSTANCE_TOGGLE") {
    rec.deleteTimes.push(now)
    rec.deleteTimes = rec.deleteTimes.filter((t) => now - t < 60_000)
    behavior().set(userId, rec)
    if (rec.deleteTimes.length >= 10) {
      await flagAbnormal(userId, `1分钟内销毁/启停${rec.deleteTimes.length}次`)
      return { abnormal: true, detail: "销毁/启停频率过高" }
    }
  }
  return { abnormal: false }
}

async function flagAbnormal(userId: string, detail: string) {
  await trackBehavior(userId, "RISK")
  await raiseAlert({
    title: "用户行为风控告警",
    level: "WARN",
    content: `用户 ${userId} 存在异常行为：${detail}，已执行风控限流`,
    resourceType: "RISK",
    resourceId: userId,
    ownerUserId: userId,
  })
}

// 多地同时在线检测（登录时调用）
export async function checkMultiLocationLogin(userId: string, currentIp: string): Promise<boolean> {
  const sessions = await db.loginSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { ip: true },
  })
  const distinctIps = new Set(sessions.map((s) => s.ip).filter(Boolean))
  distinctIps.add(currentIp)
  return distinctIps.size >= 3
}
