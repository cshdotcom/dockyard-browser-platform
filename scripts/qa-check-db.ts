import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const [ann, ws, links, har, backups, users, groups, share] = await Promise.all([
    db.announcement.count(),
    db.browserWorkspace.count(),
    db.workspaceShareLink.count(),
    db.harRecord.count(),
    db.backupRecord.count(),
    db.user.count(),
    db.group.count(),
    db.workspaceShare.count(),
  ]);
  console.log(JSON.stringify({ announcements: ann, workspaces: ws, shareLinks: links, harRecords: har, backups, users, groups, workspaceShare: share }, null, 2));
  // 检查是否有 QA 残留用户
  const suspects = await db.user.findMany({ where: { OR: [{ username: { contains: "test" } }, { username: { contains: "qa" } }, { username: { contains: "demo" } }] }, select: { username: true, role: true } });
  console.log("suspect users:", JSON.stringify(suspects));
}
main().finally(() => db.$disconnect());
