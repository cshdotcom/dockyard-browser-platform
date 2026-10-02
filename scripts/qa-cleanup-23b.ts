// QA 23-b 数据清理（幂等，可重复执行）
// 1. 删除全部自定义任务（isCustom=true）及其执行日志
// 2. 内置任务恢复：enabled=true + cronExpr/timeoutSec 恢复 seed 原值（nextRunAt 由调度器自动重算）
// 3. 清理 QA 产物审计日志（TASK 资源 id 以 custom: 开头 + 本次 QA 触发的日志清理审计）
// 用法：bunx tsx scripts/qa-cleanup-23b.ts
import { db } from "@/lib/db"

// prisma/seed.ts 内置任务注册表原值（cron / 超时）
const SEED_TASKS: { code: string; cron: string; timeout: number }[] = [
  { code: "session_idle_reclaim", name: "会话闲置回收与TTL清理", cron: "*/5 * * * *", timeout: 120 },
  { code: "singbox_status_sync", name: "SingBox实例状态同步", cron: "*/2 * * * *", timeout: 120 },
  { code: "proxy_health_probe", name: "代理节点健康探测", cron: "*/3 * * * *", timeout: 120 },
  { code: "file_expire_clean", name: "过期文件清理", cron: "*/30 * * * *", timeout: 300 },
  { code: "db_backup", name: "数据库定时备份", cron: "0 3 * * *", timeout: 900 },
  { code: "log_archive", name: "日志归档", cron: "0 4 * * *", timeout: 600 },
  { code: "alert_state_check", name: "告警状态检测（条件恢复自动标记）", cron: "*/10 * * * *", timeout: 60 },
  { code: "zombie_reclaim", name: "僵死资源回收", cron: "*/5 * * * *", timeout: 180 },
  { code: "quota_check", name: "配额超限检测", cron: "*/15 * * * *", timeout: 60 },
  { code: "token_expire", name: "API-Token过期作废与到期告警", cron: "0 * * * *", timeout: 120 },
  { code: "recycle_purge", name: "回收站到期物理清除", cron: "*/10 * * * *", timeout: 120 },
  { code: "dirty_data_clean", name: "脏数据自动清洗自愈", cron: "*/15 * * * *", timeout: 180 },
  { code: "host_probe", name: "宿主机资源采集与水位告警", cron: "*/5 * * * *", timeout: 120 },
  { code: "config_drift", name: "配置漂移检测", cron: "*/5 * * * *", timeout: 60 },
  { code: "self_check", name: "平台智能自检", cron: "0 */1 * * *", timeout: 120 },
  { code: "share_expire", name: "过期共享授权清理", cron: "*/5 * * * *", timeout: 60 },
  { code: "novnc_health", name: "NoVNC会话健康探测与闲置回收", cron: "*/2 * * * *", timeout: 120 },
  { code: "policy_deployment_activation", name: "定时策略下发到点激活", cron: "* * * * *", timeout: 120 },
  { code: "crx_install_poll", name: "CRX插件安装状态轮询（源探测+CDP检测+降级告警）", cron: "* * * * *", timeout: 180 },
  { code: "crx_gray_rollout", name: "CRX灰度策略滚动下发", cron: "* * * * *", timeout: 120 },
]

async function main() {
  // 1. 删除自定义任务 + 其日志
  const customTasks = await db.scheduleTask.findMany({ where: { isCustom: true }, select: { code: true } })
  const customCodes = customTasks.map((t) => t.code)
  let deletedLogs = 0
  if (customCodes.length > 0) {
    const r = await db.scheduleTaskLog.deleteMany({ where: { taskCode: { in: customCodes } } })
    deletedLogs = r.count
    await db.scheduleTask.deleteMany({ where: { code: { in: customCodes } } })
  }

  // 2. 内置任务恢复 seed 原值（enabled / cronExpr / timeoutSec）
  let restored = 0
  for (const t of SEED_TASKS) {
    await db.scheduleTask.update({
      where: { code: t.code },
      data: { enabled: true, cronExpr: t.cron, timeoutSec: t.timeout },
    })
    restored++
  }

  // 3. 清理 QA 产物审计（自定义任务相关 + 本次 QA 的日志清理审计 resourceId=all）
  const audit1 = await db.auditLog.deleteMany({
    where: { resourceType: "TASK", resourceId: { startsWith: "custom:" } },
  })
  const audit2 = await db.auditLog.deleteMany({
    where: { resourceType: "TASK", operationType: "TASK_LOG_CLEANUP", resourceId: "all" },
  })

  // 终态断言
  const customLeft = await db.scheduleTask.count({ where: { isCustom: true } })
  const customLogsLeft = customCodes.length
    ? await db.scheduleTaskLog.count({ where: { taskCode: { in: customCodes } } })
    : 0
  const builtinWrong = await db.scheduleTask.count({
    where: { isCustom: false, OR: SEED_TASKS.map((t) => ({ code: t.code, OR: [{ enabled: false }, { cronExpr: { not: t.cron } }] })) },
  })

  console.log(`[qa-cleanup-23b] 删除自定义任务 ${customCodes.length} 个（${customCodes.join("、") || "无"}），其日志 ${deletedLogs} 条`)
  console.log(`[qa-cleanup-23b] 内置任务恢复 seed 原值 ${restored} 个（enabled=true + cronExpr/timeoutSec）`)
  console.log(`[qa-cleanup-23b] 清理 QA 审计 ${audit1.count + audit2.count} 条（自定义任务 + 日志清理）`)
  console.log(
    customLeft === 0 && customLogsLeft === 0 && builtinWrong === 0
      ? "CLEANUP PASS：自定义任务归零、内置任务全部恢复 seed 原值"
      : `CLEANUP FAIL：customLeft=${customLeft} customLogsLeft=${customLogsLeft} builtinWrong=${builtinWrong}`
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
