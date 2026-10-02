// QA 清理：移除本轮走查产生的全部测试数据（公告/工作区/共享/链接/HAR/备份/审计快照）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // 1. QA 公告（标题含 QA 走查 / 上线 / 2FA 提醒的测试公告）
  const anns = await db.announcement.findMany({ where: { title: { in: ["平台升级维护通知（QA 走查）", "新增功能上线：批量操作与全局搜索", "安全提醒：请及时开启 2FA 双因素认证"] } }, select: { id: true } })
  const annIds = anns.map((a) => a.id)
  if (annIds.length) {
    await db.announcementRead.deleteMany({ where: { announcementId: { in: annIds } } })
    await db.announcementDismiss.deleteMany({ where: { announcementId: { in: annIds } } })
    await db.notice.deleteMany({ where: { type: "ANNOUNCEMENT", link: { in: annIds.map((id) => `/announcements?focus=${id}`) } } }).catch(() => {})
    await db.announcement.deleteMany({ where: { id: { in: annIds } } })
  }
  console.log("清理 QA 公告:", annIds.length)

  // 2. QA 工作区 + 共享 + 链接 + HAR
  const ws = await db.browserWorkspace.findFirst({ where: { name: "QA 共享测试沙箱" } })
  if (ws) {
    await db.harRecord.deleteMany({ where: { workspaceId: ws.id } })
    await db.workspaceShare.deleteMany({ where: { workspaceId: ws.id } })
    await db.workspaceShareLink.deleteMany({ where: { workspaceId: ws.id } })
    await db.browserWorkspace.delete({ where: { id: ws.id } })
    console.log("清理 QA 工作区:", ws.id)
  } else {
    console.log("无 QA 工作区")
  }

  // 3. QA 备份（文件 + 记录 + fileMeta）
  const backups = await db.backupRecord.findMany({ select: { id: true, fileMetaId: true } })
  for (const b of backups) {
    const meta = await db.fileMeta.findUnique({ where: { id: b.fileMetaId } })
    if (meta) {
      await db.fileMeta.update({ where: { id: meta.id }, data: { deletedAt: new Date() } }).catch(() => {})
    }
    await db.backupRecord.delete({ where: { id: b.id } })
  }
  console.log("清理备份记录:", backups.length)

  // 4. QA 审计/安全事件快照（保留登录类，仅清测试操作类）
  await db.auditLog.deleteMany({
    where: {
      operationType: {
        in: ["ANNOUNCEMENT_CREATE", "ANNOUNCEMENT_UPDATE", "ANNOUNCEMENT_TOGGLE", "ANNOUNCEMENT_BATCH_TOGGLE", "ANNOUNCEMENT_BATCH_DELETE",
          "ANNOUNCEMENT_READ", "AUDIT_ROLLBACK", "WORKSPACE_SHARE", "WORKSPACE_SHARE_LINK_CREATE", "WORKSPACE_SHARE_LINK_REVOKE",
          "WORKSPACE_SHARE_LINK_REDEEM", "HAR_EXPORT", "HAR_DOWNLOAD", "FILE_DOWNLOAD", "BACKUP_MANUAL", "BACKUP_AUTO",
          "USER_FORCE_2FA", "ANNOUNCEMENT_DELETE"],
      },
    },
  })
  await db.securityEvent.deleteMany({ where: { eventType: { in: ["LOGIN_FAILED", "LOGIN_PASSWORD", "LOGIN_2FA", "ACCOUNT_LOCKED", "LOGIN_BLOCKED"] } } })
  console.log("清理 QA 审计/安全事件快照")

  // 5. 残留校验
  const left = {
    announcements: await db.announcement.count(),
    workspaces: await db.browserWorkspace.count({ where: { deletedAt: null } }),
    shareLinks: await db.workspaceShareLink.count(),
    harRecords: await db.harRecord.count(),
    backups: await db.backupRecord.count(),
    auditLogs: await db.auditLog.count(),
  }
  console.log("清理后残留:", JSON.stringify(left))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
