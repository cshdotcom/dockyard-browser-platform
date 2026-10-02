// ============================================================
// Dockyard PostgreSQL 审计不可篡改触发器应用脚本（22-d）
//
// 用途：DATABASE_PROVIDER=postgres 启动时由 docker/start.sh 调用（幂等，
//   CREATE OR REPLACE / DROP IF EXISTS 语义可重复执行）：
//     DATABASE_PROVIDER=postgres DATABASE_URL=postgresql://... \
//       bun db/postgres/apply-triggers.ts        # 开发/仓库形态
//     bun /app/prisma/postgres/apply-triggers.ts # 容器形态（Dockerfile 将
//                                                 # db/postgres 复制到 /app/prisma/postgres）
// 实现说明：
//   · SQL 源 = 同目录 audit_triggers.sql（与 db/postgres/init.sql 尾部一致）
//   · 语句切分对 $$ 美元引用块感知（plpgsql 函数体内含 ";"，不能朴素按分号切）
//   · 经独立生成的 postgres PrismaClient（@prisma/client-postgres）逐条
//     $executeRawUnsafe 执行 —— 无需镜像内安装 psql/postgresql-client
// ============================================================

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 脚本所在目录（bun / node 通用；不使用 import.meta.dir —— 其类型仅在 bun-types 下存在）
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SQL_PATH = path.join(HERE, "audit_triggers.sql")

function fail(msg: string): never {
  console.error(`[apply-triggers] ${msg}`)
  process.exit(1)
}

// ---- 前置校验（仅直接执行时触发；被 import 复用切分函数时不检查环境）----
function assertEnv() {
  const url = process.env.DATABASE_URL || ""
  if (!/^postgres(ql)?:\/\//.test(url)) {
    fail(`DATABASE_URL 不是 postgresql:// 连接串（当前：${url ? url.slice(0, 16) + "…" : "未设置"}）`)
  }
  if (!fs.existsSync(SQL_PATH)) {
    fail(`找不到审计触发器 SQL 文件：${SQL_PATH}`)
  }
}

// ---- $$ 块感知的语句切分 ----
// 规则：仅当「;」位于行尾（其后至换行仅空白/注释）且不在 $$...$$ 美元引用块内时视为语句结束
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inDollarBlock = false
  for (const rawLine of sql.split("\n")) {
    const line = rawLine
    let idx = 0
    while (idx < line.length) {
      if (inDollarBlock) {
        const close = line.indexOf("$$", idx)
        if (close === -1) {
          // 块内整行均为字面内容（含函数体内的 ";"），原样累积
          current += line.slice(idx)
          idx = line.length
        } else {
          // 闭界定符 $$：连同界定符本身一并累积（保留函数体完整文本）
          current += line.slice(idx, close + 2)
          inDollarBlock = false
          idx = close + 2
        }
        continue
      }
      const open = line.indexOf("$$", idx)
      const semi = line.indexOf(";", idx)
      if (semi !== -1 && (open === -1 || semi < open)) {
        // 分号不在 $$ 块内：截取到分号处，行内剩余部分继续扫描（通常为空）
        current += line.slice(idx, semi)
        const stmt = current.trim()
        if (stmt) statements.push(stmt)
        current = ""
        idx = semi + 1
        continue
      }
      if (open !== -1) {
        current += line.slice(idx, open + 2)
        inDollarBlock = true
        idx = open + 2
        continue
      }
      current += line.slice(idx)
      idx = line.length
    }
    current += "\n"
  }
  const tail = current.trim()
  if (tail) statements.push(tail)
  // 剥离每条语句头部的整行 -- 注释（头部说明注释与首条语句同行累积的场景），空语句丢弃
  return statements
    .map((s) => {
      const lines = s.split("\n")
      let i = 0
      while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("--"))) i++
      return lines.slice(i).join("\n").trim()
    })
    .filter((s) => s.length > 0)
}

async function main() {
  assertEnv()
  // 独立生成的 postgres 客户端（generator output = node_modules/@prisma/client-postgres）
  const { PrismaClient } = (await import("@prisma/client-postgres")) as typeof import("@prisma/client-postgres")
  const db = new PrismaClient()
  try {
    const sql = fs.readFileSync(SQL_PATH, "utf8")
    const statements = splitSqlStatements(sql)
    let applied = 0
    for (const stmt of statements) {
      const head = stmt.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("--")) || ""
      await db.$executeRawUnsafe(stmt)
      applied++
      console.log(`[apply-triggers] ✓ ${head.slice(0, 72)}`)
    }
    console.log(`[apply-triggers] 完成：${applied} 条语句已应用（AuditLog / AuditLogArchive 不可篡改保护已生效）`)
  } finally {
    await db.$disconnect()
  }
}

// 仅在作为入口脚本直接执行时运行 main（被 import 复用切分函数时不触发数据库连接）
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((e) => fail(`执行失败：${e instanceof Error ? e.message : String(e)}`))
}
