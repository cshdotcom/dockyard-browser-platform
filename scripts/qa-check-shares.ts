import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const shares = await db.workspaceShare.findMany({ select: { workspaceId: true, permission: true, revokedAt: true, targetUserId: true } })
  const users = await db.user.findMany({ where: { id: { in: shares.map((s) => s.targetUserId) } }, select: { id: true, username: true } })
  const map = new Map(users.map((u) => [u.id, u.username]))
  for (const s of shares) console.log(`target=${map.get(s.targetUserId)} perm=${s.permission} revoked=${!!s.revokedAt} ws=${s.workspaceId.slice(0, 8)}`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
