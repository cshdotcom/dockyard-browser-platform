// QA 清理：r22b 共享系统增强测试产物（多选共享/移除接收者/外链兑换/按用户·组清退）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // 1. 测试工作区「共享增强测试沙箱」及其关联（共享/链接/运行日志/CDP/HAR/用量/回收站快照）
  const wsList = await db.browserWorkspace.findMany({
    where: { name: { startsWith: "共享增强测试沙箱" } },
    select: { id: true },
  })
  const wsIds = wsList.map((w) => w.id)
  let wsDeleted = 0
  if (wsIds.length) {
    await db.workspaceShare.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.workspaceShareLink.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.browserScriptRunLog.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.cdpRecording.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.harRecord.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.proxyUsage.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.crxInstallStatus.deleteMany({ where: { workspaceId: { in: wsIds } } })
    await db.recycleBin.deleteMany({ where: { resourceType: "WORKSPACE", resourceId: { in: wsIds } } })
    const r = await db.browserWorkspace.deleteMany({ where: { id: { in: wsIds } } })
    wsDeleted = r.count
  }

  // 2. 残余共享/链接兜底清零（本轮全部为测试数据）
  await db.workspaceShare.deleteMany({})
  await db.workspaceShareLink.deleteMany({})

  // 3. 测试用户 qa3（多选/兑换/清退测试专用）
  const qa3 = await db.user.findUnique({ where: { username: "qa3" } })
  if (qa3) {
    await db.groupUser.deleteMany({ where: { userId: qa3.id } })
    await db.groupAdmin.deleteMany({ where: { userId: qa3.id } })
    await db.refreshToken.deleteMany({ where: { userId: qa3.id } }).catch(() => {})
    await db.loginSession.deleteMany({ where: { userId: qa3.id } })
    await db.securityEvent.deleteMany({ where: { userId: qa3.id } })
    await db.notice.deleteMany({ where: { userId: qa3.id } })
    await db.user.delete({ where: { id: qa3.id } })
  }

  // 4. 本轮测试审计/安全事件/登录会话快照
  await db.auditLog.deleteMany({
    where: {
      operationType: {
        in: ["WORKSPACE_CREATE", "WORKSPACE_SHARE", "WORKSPACE_SHARE_REVOKE", "WORKSPACE_SHARE_LINK_CREATE",
          "WORKSPACE_SHARE_LINK_REDEEM", "SHARE_ADMIN_EVICT", "LOGOUT"],
      },
    },
  })
  await db.securityEvent.deleteMany({ where: { eventType: { in: ["LOGIN_PASSWORD", "LOGOUT"] } } })
  await db.loginSession.deleteMany({})

  // 5. 终态校验
  const left = {
    users: await db.user.count(),
    groups: await db.group.count(),
    workspaces: await db.browserWorkspace.count(),
    shares: await db.workspaceShare.count(),
    shareLinks: await db.workspaceShareLink.count(),
    qa3: await db.user.count({ where: { username: "qa3" } }),
  }
  console.log("清理工作区:", wsDeleted, "| 终态:", JSON.stringify(left))
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
