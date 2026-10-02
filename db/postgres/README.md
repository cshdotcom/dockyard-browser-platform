# PostgreSQL 部署资产（22-d）

Dockyard 默认使用 **SQLite**（零依赖，`/app/db/custom.db`）。需要 PostgreSQL 时通过
环境变量切换，平台**启动时自动完成全部初始化**（建表 → 审计触发器 → 种子），
无需人工导入任何 SQL。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_PROVIDER` | `sqlite`（默认）/ `postgres`；兼容历史别名 `DB_PROVIDER` |
| `DATABASE_URL` | postgres 连接串，如 `postgresql://user:pass@host:5432/dockyard` |

```bash
docker run -d --name dockyard --network host \
  -e DATABASE_PROVIDER=postgres \
  -e DATABASE_URL=postgresql://dockyard:secret@10.0.0.5:5432/dockyard \
  ... ghcr.io/cshdotcom/dockyard-browser-platform:latest
```

启动日志出现「数据库已自动初始化（postgres）」即完成；流程幂等，可重复执行（升级镜像后重启即自动对齐结构）。

## 目录内容

| 文件 | 用途 |
|---|---|
| `../prisma/schema.postgres.prisma` | PostgreSQL schema（由 `scripts/db/sync-postgres-schema.ts` 从主 schema `prisma/schema.prisma` 自动派生，模型零漂移；**勿手改**） |
| `schema.sql` | 全量建表 DDL（`prisma migrate diff --from-empty` 生成，供人工核对/导入） |
| `init.sql` | **一键人工初始化脚本** = 全量 DDL + 审计不可篡改触发器（自动初始化的人工等价物） |
| `audit_triggers.sql` | 审计不可篡改触发器（AuditLog/AuditLogArchive 仅允许 INSERT，数据库层防线） |
| `apply-triggers.ts` | 触发器自动应用脚本（start.sh 调用；$$ 块感知切分 + Prisma `$executeRawUnsafe`，无需 psql） |
| `../../prisma/seed-postgres.ts` | PostgreSQL 种子（超管/默认配置/内置任务，与 `prisma/seed.ts` 同步维护） |

## 两条初始化路径（等价，任选其一）

**路径一（推荐）：启动自动初始化**
`docker/start.sh` 检测 `DATABASE_PROVIDER=postgres`：
1. `prisma db push --schema prisma/schema.postgres.prisma`（幂等建表，失败自动重试 3 次）
2. `apply-triggers.ts` 应用审计触发器（幂等，失败仅警告不阻断）
3. `prisma/seed-postgres.ts` 播种（幂等）

**路径二：人工导入 init.sql**
适合 DBA 预建库、平台账号无 DDL 权限等场景：
```bash
psql -h <host> -U <user> -d <dockyard> -f db/postgres/init.sql
# 之后正常启动平台（种子仍由启动流程自动播种）
```

## 开发命令（package.json scripts）

```bash
bun run db:sync-pg-schema    # 主 schema 变更后重新派生 schema.postgres.prisma（并注入独立 generator output）
bun run db:generate:postgres # 生成 postgres PrismaClient → node_modules/@prisma/client-postgres
bun run db:init:postgres     # push + triggers + seed（需 DATABASE_URL 指向可用 PG）
```

## 模型变更流程

1. 修改 `prisma/schema.prisma`（唯一事实源）
2. `bun scripts/db/sync-postgres-schema.ts` → 重新派生 `prisma/schema.postgres.prisma`
3. `bunx prisma generate` + `bunx prisma generate --schema prisma/schema.postgres.prisma`
4. 重新生成 DDL：`bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script > db/postgres/schema.sql`（并同步更新 init.sql 尾部触发器段）
5. 容器重启即自动 `db push` 对齐结构（SQLite 与 PostgreSQL 同步演进）

## 运行时原理

- `src/lib/db.ts` 按 `DATABASE_PROVIDER` 实例化对应客户端：SQLite → `@prisma/client`；
  PostgreSQL → `@prisma/client-postgres`（独立生成的 client，查询引擎随镜像分发）
- 两份 schema 模型逐字一致，全应用共用同一套 TypeScript 类型
- 审计只插入约束：应用层（`src/lib/audit.ts`）+ 数据库层触发器双重防线
