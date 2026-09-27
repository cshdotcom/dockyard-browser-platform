// 独立数据库初始化/维护脚本（Docker 外手动部署或运维场景使用）
// 用法：DATABASE_URL=file:./db/custom.db bun scripts/init-db.ts
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

async function main() {
  console.log("[init-db] 连接数据库…")
  const [users, groups, tasks, configs] = await Promise.all([
    db.user.count(),
    db.group.count(),
    db.scheduleTask.count(),
    db.systemConfig.count(),
  ])
  console.log(`[init-db] 当前数据：用户 ${users} · 用户组 ${groups} · 定时任务 ${tasks} · 配置项 ${configs}`)
  if (users === 0) {
    console.log("[init-db] 数据库为空，请执行：bunx prisma db push && bunx tsx prisma/seed.ts")
  } else {
    console.log("[init-db] 数据库已初始化，健康正常 ✓")
  }
}

main()
  .catch((e) => {
    console.error("[init-db] 数据库连接失败：", e.message)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
