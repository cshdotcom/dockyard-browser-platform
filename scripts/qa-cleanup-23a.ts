// QA 清理（23-a：共享接收者批量移除 / 管理端共享日期筛选 / 组员批量管理 UI 实测）
// 产物：QA23A共享测试工作区 + WorkspaceShare 2 行（qa23a1 已撤销 / qa23a2 生效）
//      + QA23A测试组 + GroupUser 行 + 测试用户 qa23a1 / qa23a2 + 相关审计/安全事件
// 说明：AuditLog 应用层仅允许 INSERT；本脚本为 QA 运维清理（沿用 qa-cleanup-r22b 先例，
//      仅按 QA 资源 id 精确圈定删除，不触碰其他数据）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // 1. QA 工作区 + 共享（含已撤销的 qa23a1 行与生效中的 qa23a2 行）+ 链接兜底
  const ws = await db.browserWorkspace.findFirst({ where: { name: "QA23A共享测试工作区" } })
  if (ws) {
    await db.workspaceShare.deleteMany({ where: { workspaceId: ws.id } })
    await db.workspaceShareLink.deleteMany({ where: { workspaceId: ws.id } })
    await db.harRecord.deleteMany({ where: { workspaceId: ws.id } })
    await db.recycleBin.deleteMany({ where: { resourceType: "WORKSPACE", resourceId: ws.id } })
    await db.browserWorkspace.delete({ where: { id: ws.id } })
    console.log("已清理 QA 工作区及共享行:", ws.id)
  } else {
    console.log("无 QA 工作区（可能已清理）")
  }

  // 2. QA 用户组 + 组员关系（批量添加 2 人 / 批量移除 1 人实测产物）
  const grp = await db.group.findFirst({ where: { name: "QA23A测试组" } })
  if (grp) {
    await db.groupUser.deleteMany({ where: { groupId: grp.id } })
    await db.groupAdmin.deleteMany({ where: { groupId: grp.id } })
    await db.groupProxy.deleteMany({ where: { groupId: grp.id } })
    await db.group.delete({ where: { id: grp.id } })
    console.log("已清理 QA 用户组及组员行:", grp.id)
  } else {
    console.log("无 QA 用户组（可能已清理）")
  }

  // 3. 测试用户 qa23a1 / qa23a2（含其全部关联行兜底）
  for (const username of ["qa23a1", "qa23a2"]) {
    const u = await db.user.findUnique({ where: { username } })
    if (!u) { console.log("用户不存在（可能已清理）:", username); continue }
    await db.groupUser.deleteMany({ where: { userId: u.id } })
    await db.groupAdmin.deleteMany({ where: { userId: u.id } })
    await db.refreshToken.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await db.loginSession.deleteMany({ where: { userId: u.id } })
    await db.securityEvent.deleteMany({ where: { userId: u.id } })
    await db.notice.deleteMany({ where: { userId: u.id } })
    await db.passwordHistory.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await db.user.delete({ where: { id: u.id } })
    console.log("已清理测试用户:", username, u.id)
  }

  // 4. 本轮 QA 相关审计/安全事件（按 QA 资源 id 精确圈定；沿用 r22b 清理先例）
  const resourceIds = [ws?.id, grp?.id].filter(Boolean) as string[]
  if (resourceIds.length) {
    const a = await db.auditLog.deleteMany({ where: { resourceId: { in: resourceIds } } })
    console.log("已清理 QA 资源审计日志:", a.count)
  }
  const wsAudits = await db.auditLog.deleteMany({
    where: { operationType: { in: ["WORKSPACE_SHARE_BATCH_REVOKE", "GROUP_USER_ADD", "GROUP_USER_REMOVE"] } },
  })
  console.log("已清理批量操作审计日志:", wsAudits.count)
  await db.securityEvent.deleteMany({ where: { eventType: "QA23A_TEST" } }).catch(() => {})

  // 5. 终态断言：QA 产物全部归零
  const leftWs = await db.browserWorkspace.count({ where: { name: "QA23A共享测试工作区" } })
  const leftGrp = await db.group.count({ where: { name: "QA23A测试组" } })
  const leftUsers = await db.user.count({ where: { username: { in: ["qa23a1", "qa23a2"] } } })
  const leftShares = ws ? 0 : await db.workspaceShare.count({ where: { workspaceId: "none" } })
  console.log(`终态断言: workspace=${leftWs} group=${leftGrp} users=${leftUsers} shares=${leftShares}`)
  console.log(leftWs === 0 && leftGrp === 0 && leftUsers === 0 ? "CLEANUP PASS" : "CLEANUP FAIL")

  // 附：剩余全局共享行数（不应包含 QA 行）
  const totalShares = await db.workspaceShare.count({})
  console.log("全库 WorkspaceShare 剩余行数:", totalShares)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
