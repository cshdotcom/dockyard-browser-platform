// QA 清理：r13 深化迭代轮（2FA 门控/SMTP/内网穿透/网关/CRX 灰度/告警规则）全量测试产物
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // 1. demo 恢复种子状态（关 2FA + 清强制标记）
  await db.user.update({ where: { username: "demo" }, data: { twoFactorEnabled: false, force2faSetup: false } })

  // 2. CRX QA 产物（插件库/灰度任务/策略条目）
  const gray = await db.crxGrayTask.deleteMany({})
  const entries = await db.crxPolicyEntry.deleteMany({})
  const plugins = await db.crxPlugin.deleteMany({ where: { name: { startsWith: "QA" } } })
  console.log("清理 CRX:", JSON.stringify({ gray: gray.count, entries: entries.count, plugins: plugins.count }))

  // 3. QA 告警规则 / 工作区
  const rules = await db.alertRule.deleteMany({ where: { name: { startsWith: "QA" } } })
  const ws = await db.browserWorkspace.deleteMany({ where: { name: { startsWith: "内网穿透链路测试" } } })
  await db.workspaceShare.deleteMany({})
  await db.workspaceShareLink.deleteMany({})
  console.log("清理规则/工作区:", JSON.stringify({ rules: rules.count, workspaces: ws.count }))

  // 4. QA 审计/安全事件/登录会话快照
  await db.auditLog.deleteMany({
    where: {
      operationType: {
        in: ["CRX_PLUGIN_CREATE", "CRX_GRAY_CREATE", "CRX_POLICY_SET", "ALERT_RULE_CREATE", "SMTP_CONFIG_UPDATE",
          "USER_FORCE_2FA", "VNC_TICKET_ISSUE", "FILE_DOWNLOAD", "HAR_EXPORT", "ANNOUNCEMENT_CREATE",
          "ANNOUNCEMENT_BATCH_TOGGLE", "AUDIT_ROLLBACK", "WORKSPACE_CREATE", "WORKSPACE_SHARE", "WORKSPACE_SHARE_LINK_CREATE",
          "WORKSPACE_SHARE_LINK_REDEEM", "BACKUP_MANUAL", "BACKUP_BATCH_DELETE", "USER_UPDATE"],
      },
    },
  })
  await db.securityEvent.deleteMany({ where: { eventType: { in: ["LOGIN_EMAIL_CODE", "LOGIN_PASSWORD", "LOGIN_2FA"] } } })
  await db.loginSession.deleteMany({})
  console.log("清理审计/安全事件/登录会话")

  // 5. 终态校验
  const left = {
    announcements: await db.announcement.count(),
    workspaces: await db.browserWorkspace.count(),
    shareLinks: await db.workspaceShareLink.count(),
    harRecords: await db.harRecord.count(),
    backups: await db.backupRecord.count(),
    crxPlugins: await db.crxPlugin.count(),
    crxGray: await db.crxGrayTask.count(),
    alertRules: await db.alertRule.count(),
    auditLogs: await db.auditLog.count(),
  }
  console.log("清理后残留:", JSON.stringify(left))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
