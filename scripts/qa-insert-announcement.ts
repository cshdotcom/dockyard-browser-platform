// QA 辅助：直插第二条跑马灯公告（验证 30s 轮询实时性 + 多条合并 +N 折叠）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  await db.announcement.create({
    data: {
      title: "新增功能上线：批量操作与全局搜索",
      content: "支持**全功能批量操作**（含告警中心/备份恢复）与全局搜索，详见更新日志。",
      type: "GLOBAL",
      displayType: "MARQUEE",
      displayTypes: JSON.stringify(["MARQUEE"]),
      notifyInbox: false,
      enabled: true,
      allowDismiss: true,
      persistAfterRead: false,
    },
  })
  const count = await db.announcement.count({ where: { enabled: true } })
  console.log("已插入，当前启用公告数:", count)
}

main().finally(() => db.$disconnect())
