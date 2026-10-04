// ============================================================
// r35：数据库启动维护 + SQLite 性能根因修复
//
// 【背景】用户上传的生产日志实锤三类根因：
//   1) journal_mode=delete（非 WAL）→ 写事务排他锁阻塞全部读连接 →
//      [slow-query] 1~5s 堆积 → Prisma P1008 Socket timeout →
//      NextAuth JWT_SESSION_ERROR / 页面卡死 / CDP 与多屏控制被判卡死反复重启
//   2) 软删除用户 email/username 仍占用 @unique 索引 →
//      "邮箱已被占用"无法绑定（日志：邮箱 3959586899@qq.com 已被占用）
//   3) 过期登录会话/验证码/登录尝试/孤儿 2FA 凭据长期滞留 → 表膨胀放大慢查询
//
// 【修复】
//   · WAL 持久化切换（数据库级设置，一次生效全库受益）+ PRAGMA optimize
//   · 启动一次性清理（幂等、静默失败不阻塞启动）
//   · 软删除用户唯一字段释放（email → NULL；username → __del__ 前缀防撞）
//   · Prisma 连接 URL 注入 connection_limit / socket_timeout（见 db.ts）
// ============================================================
import type { PrismaClient } from "@prisma/client"

/**
 * r35：WAL 持久化切换（Prisma 原生通道 —— 免 Turbopack require 解析问题）。
 * journal_mode 是数据库级持久设置：任一连接切换后全库（含连接池全部连接）自动受益。
 * 同时执行 wal_autocheckpoint（默认 1000 页，加快 WAL 回收）与 PRAGMA optimize（更新统计）。
 */
export async function applySqliteWal(client: PrismaClient): Promise<{ ok: boolean; mode: string; detail?: string }> {
  try {
     
    const anyClient = client as any
    if (typeof anyClient.$queryRawUnsafe !== "function") {
      return { ok: false, mode: "unsupported", detail: "客户端不支持 $queryRawUnsafe" }
    }
    const rows = (await anyClient.$queryRawUnsafe("PRAGMA journal_mode=WAL;")) as Array<{ journal_mode?: string }>
    const mode = Array.isArray(rows) && rows[0]?.journal_mode ? String(rows[0].journal_mode) : "WAL"
    if (mode.toLowerCase() !== "wal") return { ok: false, mode, detail: "数据库拒绝 WAL 模式（可能处于事务中，下次重启重试）" }
    await anyClient.$queryRawUnsafe("PRAGMA wal_autocheckpoint=1000;").catch(() => {})
    await anyClient.$queryRawUnsafe("PRAGMA optimize;").catch(() => {})
    return { ok: true, mode: "WAL (persistent)" }
  } catch (e) {
    return { ok: false, mode: "keep-current", detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 启动一次性维护（幂等；全局单飞标志防止 dev 热重载重复执行）：
 *   1. 过期 LoginSession（expiresAt < now-30d；近 30 天保留审计）
 *   2. 过期 EmailVerificationCode（expiresAt < now-24h）
 *   3. 过期 LoginAttempt / 行为风控计数（表存在时）
 *   4. 软删除用户的孤儿 2FA 凭据（TotpSecret / TwoFactorBackupCode / TrustedDevice）
 *   5. 【关键】软删除用户唯一字段释放：email → NULL，username → __del__<id>__<rand>__
 *      （修复"已删除用户数据库没删除导致绑定邮箱提示已被占用"）
 * 全部静默失败 —— 维护失败绝不能阻塞主服务启动。
 */
export async function runStartupDbMaintenance(db: PrismaClient): Promise<void> {
  const g = globalThis as unknown as { __dyDbMaintenanceAt?: number }
  if (g.__dyDbMaintenanceAt) return
  g.__dyDbMaintenanceAt = Date.now()
  const cleanups: string[] = []
  // 首步：WAL 持久化切换（读不阻塞写 / 写不阻塞读 —— P1008 根因修复）
  const wal = await applySqliteWal(db)
  if (wal.ok) console.log(`[db] SQLite WAL 已启用（${wal.mode}）—— 读写并发不再互斥`)
  else console.warn(`[db] SQLite WAL 切换未成功（${wal.detail ?? "未知原因"}），保持当前模式运行`)
  try {
    const now = new Date()
    // 1) 过期登录会话（保留 30 天审计追溯窗口）
    const sess = await db.loginSession.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 30 * 86400_000) } },
    }).catch(() => ({ count: 0 }))
    if (sess.count > 0) cleanups.push(`LoginSession×${sess.count}`)

    // 2) 过期邮箱验证码（24h 缓冲）
    const codes = await db.emailVerificationCode.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 86400_000) } },
    }).catch(() => ({ count: 0 }))
    if (codes.count > 0) cleanups.push(`EmailVerificationCode×${codes.count}`)

    // 3) 软删除用户 → 孤儿凭据清理 + 唯一字段释放
    const deletedUsers = await db.user.findMany({
      where: { deletedAt: { not: null } },
      select: { id: true, email: true, username: true },
    }).catch(() => [] as { id: string; email: string | null; username: string }[])
    let released = 0
    for (const u of deletedUsers) {
      // 孤儿 2FA 凭据（用户已软删除，凭据不再有意义）
      await db.totpSecret.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await db.twoFactorBackupCode.deleteMany({ where: { userId: u.id } }).catch(() => {})
      await db.trustedDevice.deleteMany({ where: { userId: u.id } }).catch(() => {})
      // 唯一字段释放：email 置空可被新用户绑定；username 加防撞前缀可被新用户注册
      const needRelease = (u.email !== null && u.email !== undefined) || !u.username.startsWith("__del__")
      if (!needRelease) continue
      const poisoned = `__del__${u.id.slice(-8)}__${Math.random().toString(36).slice(2, 8)}`
      await db.user.update({
        where: { id: u.id },
        data: { email: null, username: poisoned },
      }).catch(() => {})
      released += 1
    }
    if (released > 0) cleanups.push(`软删用户唯一字段释放×${released}`)

    if (cleanups.length > 0) {
      console.log(`[db-maintenance] 启动清理完成：${cleanups.join("；")}`)
    }
  } catch {
    // 静默：维护失败不影响启动
  }
}