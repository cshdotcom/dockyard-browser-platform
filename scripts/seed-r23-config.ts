// r23：播种新增配置键（幂等 upsert）+ 为既有定时任务补 taskType/nextRunAt
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

const KEYS: [string, unknown, string, string, string][] = [
  ["security.force2faAdminExempt", false, "SECURITY", "boolean", "强制2FA豁免管理员"],
  ["security.ipBanEnabled", true, "SECURITY", "boolean", "IP自动封禁开关"],
  ["security.ipBanThreshold", 10, "SECURITY", "number", "IP封禁阈值"],
  ["security.ipBanWindowMinutes", 15, "SECURITY", "number", "失败计数窗口（分钟）"],
  ["security.ipBanMinutes", 30, "SECURITY", "number", "IP封禁时长（分钟）"],
  ["security.ipBanApiCountEnabled", true, "SECURITY", "boolean", "API-Key无效调用计入IP封禁"],
  ["security.ipBanAlertEnabled", true, "SECURITY", "boolean", "IP封禁告警开关"],
  ["alert.emailEnabled", false, "ALERT", "boolean", "告警邮件通知开关"],
  ["alert.emailMinLevel", "ERROR", "ALERT", "string", "邮件告警最低级别"],
  ["alert.emailRecipients", "", "ALERT", "string", "邮件告警收件人"],
  ["alert.hostEnabled", true, "ALERT", "boolean", "宿主机资源水位预警开关"],
  ["alert.cpuThresholdPct", 80, "ALERT", "number", "CPU预警阈值%"],
  ["alert.memThresholdPct", 85, "ALERT", "number", "内存预警阈值%"],
  ["alert.diskThresholdPct", 85, "ALERT", "number", "磁盘预警阈值%"],
  ["alert.sessionQuotaEnabled", true, "ALERT", "boolean", "会话配额水位预警"],
  ["alert.singboxTrafficEnabled", true, "ALERT", "boolean", "SingBox流量超限预警"],
  ["alert.proxyFailEnabled", true, "ALERT", "boolean", "代理节点故障预警"],
  ["alert.backupFailEnabled", true, "ALERT", "boolean", "备份异常预警"],
  ["alert.tokenExpireEnabled", true, "ALERT", "boolean", "Token到期预警"],
  ["alert.zombieReclaimEnabled", true, "ALERT", "boolean", "僵死会话回收预警"],
  ["alert.configDriftEnabled", true, "ALERT", "boolean", "配置漂移预警"],
  ["alert.taskFailEnabled", true, "ALERT", "boolean", "定时任务连续失败预警"],
  ["alert.quotaUserEnabled", true, "ALERT", "boolean", "用户磁盘配额水位预警"],
]

async function main() {
  for (const [key, value, category, type, description] of KEYS) {
    await db.systemConfig.upsert({
      where: { key },
      update: {},
      create: { key, valueJson: JSON.stringify(value), category, valueType: type, description },
    })
  }
  console.log(`[r23-seed] 配置键 ${KEYS.length} 项已确保存在`)
  // 既有内置任务补 taskType=code（runTask 解析用）
  const tasks = await db.scheduleTask.findMany({ where: { isCustom: false } })
  let fixed = 0
  for (const t of tasks) {
    const patch: Record<string, unknown> = {}
    if (!t.taskType) { patch.taskType = t.code; fixed++ }
    if (t.nextRunAt === null) { patch.nextRunAt = new Date(Date.now() + 60_000) }
    if (Object.keys(patch).length > 0) await db.scheduleTask.update({ where: { code: t.code }, data: patch })
  }
  console.log(`[r23-seed] 内置任务 ${tasks.length} 项，补齐 taskType ${fixed} 项 + nextRunAt`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
