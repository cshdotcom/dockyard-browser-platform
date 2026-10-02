// QA 辅助（Task 22-a）：直插公告 + 站内信测试数据，验证搜索/详情弹窗/站内信小弹窗/focus 定位
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const admin = await db.user.findFirst({ where: { username: "admin", deletedAt: null }, select: { id: true } })
  if (!admin) throw new Error("admin 用户不存在")

  // 1. 常规公告（跑马灯+弹窗通道，含长 Markdown 内容验证详情滚动）
  const longContent = [
    "## 平台升级维护通知（QA 长文测试）",
    "",
    "本次公告用于验证**详情弹窗限高滚动**：以下为长内容段落。",
    ...Array.from({ length: 12 }, (_, i) => `\n第 ${i + 1} 段：验证长公告内容在详情弹窗内正确滚动、不溢出、不显示错乱。支持 **加粗**、*斜体*、[链接](https://example.com) 与行内 \`code\`。`),
    "",
    "| 列1 | 列2 |",
    "| --- | --- |",
    "| A | B |",
    "| C | D |",
  ].join("\n")
  const a1 = await db.announcement.create({
    data: {
      title: "QA-22a 平台升级维护通知",
      content: longContent,
      type: "GLOBAL",
      displayType: "MARQUEE",
      displayTypes: JSON.stringify(["MARQUEE", "POPUP"]),
      notifyInbox: false,
      enabled: true,
      allowDismiss: true,
      persistAfterRead: false,
    },
  })

  // 2. 仅站内信公告（无展示通道 → 验证 focus 落地把公告纳入列表并打开详情）
  const a2 = await db.announcement.create({
    data: {
      title: "QA-22a 仅站内信公告",
      content: "这条公告只走站内信通道，验证通知铃「查看详情」→ focus 落地后仍能打开详情弹窗。",
      type: "GLOBAL",
      displayType: "POPUP",
      displayTypes: JSON.stringify([]),
      notifyInbox: true,
      enabled: true,
      allowDismiss: true,
      persistAfterRead: false,
      notifiedAt: new Date(),
    },
  })

  // 3. 站内信（管理员）：公告类（link 携带 focus）+ 系统类（无 link）
  await db.notice.createMany({
    data: [
      {
        userId: admin.id,
        title: "【公告】QA-22a 仅站内信公告",
        content: "这条公告只走站内信通道，验证通知铃「查看详情」→ focus 落地后仍能打开详情弹窗。",
        type: "ANNOUNCEMENT",
        link: `/announcements?focus=${a2.id}`,
      },
      {
        userId: admin.id,
        title: "QA-22a 系统维护提醒",
        content: "系统将于本周日凌晨 2:00-4:00 进行例行维护，期间服务可能出现短暂中断。此通知无跳转链接，用于验证无 link 时「查看详情」按钮不显示。".repeat(1),
        type: "SYSTEM",
      },
    ],
  })

  const counts = await Promise.all([db.announcement.count(), db.notice.count()])
  console.log(`已插入：公告 a1=${a1.id}（MARQUEE+POPUP） a2=${a2.id}（仅站内信）；当前公告总数=${counts[0]} 通知总数=${counts[1]}`)
  console.log(`focus 链接=/announcements?focus=${a2.id}`)
}

main().finally(() => db.$disconnect())
