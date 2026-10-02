// QA 辅助：验证分享链接兑换结果（绑定 + 计数 + 审计）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const l = await db.workspaceShareLink.findFirst({ orderBy: { createdAt: "desc" } })
  const s = await db.workspaceShare.findFirst({ where: { workspaceId: l!.workspaceId } })
  const target = s ? await db.user.findUnique({ where: { id: s.targetUserId }, select: { username: true } }) : null
  const auditCount = await db.auditLog.count({ where: { operationType: "WORKSPACE_SHARE_LINK_REDEEM" } })
  console.log(JSON.stringify({
    useCount: l!.useCount,
    lastUsedAt: !!l!.lastUsedAt,
    shareBoundTo: target?.username,
    permission: s?.permission,
    redeemAuditCount: auditCount,
  }))
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
