// PGlite TCP 服务器 —— QA 用真实 PostgreSQL 协议端点（127.0.0.1:5433）
// 用途：验证 DB_PROVIDER=postgres 全自动初始化链路（prisma db push + seed + 审计触发器 + 平台运行）
// 运行：bun scripts/pg-test/pg-server.mjs（数据落盘 ./pgdata，可重复启动）
import { PGlite } from "@electric-sql/pglite"
import { createSocketServer } from "@electric-sql/pglite-socket"
import { mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, "pgdata")
mkdirSync(DATA, { recursive: true })

const db = await PGlite.create({
  connectionString: `file://${DATA}`,
  database: "dockyard",
  username: "pg",
  password: "pg",
})

const server = createSocketServer({ db, port: 5433, host: "127.0.0.1" })
console.log(`[pg-server] PGlite(真实 PG 协议) 已监听 postgresql://pg:pg@127.0.0.1:5433/dockyard，数据目录 ${DATA}`)

// 保持进程存活
setInterval(() => {}, 1 << 30)
