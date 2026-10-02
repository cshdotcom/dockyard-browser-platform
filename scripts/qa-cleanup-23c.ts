// QA 23-c 数据清理（幂等，可重复执行）
// 1. IpBanRecord 测试行清理（192.0.2.99 / reason 含 QA23c 的行）
// 2. alert.* 配置恢复 seed 默认值（emailEnabled=false / cpu 80 / mem 85 / disk 85 / emailRecipients=""）
//    —— 走 setConfig 生成回滚版本快照，保持版本历史一致
// 3. 清理 QA 产物审计（IP_BAN_MANUAL / IP_UNBAN_MANUAL / IP_BAN_RECORD_DELETE resourceName=192.0.2.99
//    + 本次 QA 产生的 CONFIG_UPDATE alert.* 审计）
// 用法：bunx tsx scripts/qa-cleanup-23c.ts
import { db } from "@/lib/db"
import { setConfig } from "@/lib/config"

const QA_IP = "192.0.2.99"
const QA_IP_PREFIX = "192.0.2." // QA 保留网段（RFC 5737 文档示例段）

// seed-r23-config.ts 预警中心默认值
const ALERT_DEFAULTS: { key: string; value: unknown }[] = [
  { key: "alert.emailEnabled", value: false },
  { key: "alert.emailMinLevel", value: "ERROR" },
  { key: "alert.emailRecipients", value: "" },
  { key: "alert.cpuThresholdPct", value: 80 },
  { key: "alert.memThresholdPct", value: 85 },
  { key: "alert.diskThresholdPct", value: 85 },
]

async function main() {
  // 1. IpBanRecord 测试行
  const banRows = await db.ipBanRecord.findMany({
    where: { OR: [{ ip: QA_IP }, { ip: { startsWith: QA_IP_PREFIX }, reason: { contains: "QA23c" } }] },
    select: { id: true, ip: true, source: true },
  })
  const banIds = banRows.map((r) => r.id)
  let deletedBans = 0
  if (banIds.length > 0) deletedBans = (await db.ipBanRecord.deleteMany({ where: { id: { in: banIds } } })).count

  // 2. alert 配置恢复默认（仅当偏离默认时执行，幂等）
  let restored = 0
  for (const d of ALERT_DEFAULTS) {
    const row = await db.systemConfig.findUnique({ where: { key: d.key }, select: { valueJson: true } })
    if (!row) continue
    const cur = JSON.parse(row.valueJson)
    if (JSON.stringify(cur) !== JSON.stringify(d.value)) {
      await setConfig(d.key, d.value, undefined) // operator 空 → 版本历史记「系统」
      restored++
    }
  }

  // 3. QA 审计清理
  const a1 = await db.auditLog.deleteMany({
    where: { resourceName: QA_IP, operationType: { in: ["IP_BAN_MANUAL", "IP_UNBAN_MANUAL", "IP_BAN_RECORD_DELETE"] } },
  })
  const a2 = await db.auditLog.deleteMany({
    where: {
      operationType: "CONFIG_UPDATE",
      resourceType: "CONFIG",
      resourceId: { in: ALERT_DEFAULTS.map((d) => d.key) },
      AND: [{ afterJson: { contains: "true" } }, { resourceId: "alert.emailEnabled" }],
    },
  })

  // 终态断言
  const ipbanLeft = await db.ipBanRecord.count({ where: { OR: [{ ip: QA_IP }, { reason: { contains: "QA23c" } }] } })
  const emailEnabled = JSON.parse((await db.systemConfig.findUnique({ where: { key: "alert.emailEnabled" } }))?.valueJson ?? "false")
  const thresholds = await db.systemConfig.findMany({
    where: { key: { in: ["alert.cpuThresholdPct", "alert.memThresholdPct", "alert.diskThresholdPct"] } },
    select: { key: true, valueJson: true },
  })
  const thresholdsOk = thresholds.every((t) =>
    t.key === "alert.cpuThresholdPct" ? t.valueJson === "80" : t.valueJson === "85"
  )

  console.log(`[qa-cleanup-23c] IpBanRecord 测试行删除 ${deletedBans} 条（${banRows.map((r) => r.ip).join("、") || "无"}）`)
  console.log(`[qa-cleanup-23c] alert 配置恢复默认 ${restored} 项（emailEnabled=false / 阈值 80/85/85）`)
  console.log(`[qa-cleanup-23c] 清理 QA 审计 ${a1.count + a2.count} 条（IP封禁操作 ${a1.count} + CONFIG_UPDATE ${a2.count}）`)
  console.log(
    ipbanLeft === 0 && emailEnabled === false && thresholdsOk
      ? "CLEANUP PASS：IP封禁测试行归零，预警配置恢复 seed 默认"
      : `CLEANUP FAIL：ipbanLeft=${ipbanLeft} emailEnabled=${emailEnabled} thresholdsOk=${thresholdsOk}`
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
