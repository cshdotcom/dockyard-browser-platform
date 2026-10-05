import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import {
  db, databaseProvider, effectiveDatabaseConfig, probeDatabase, rebuildDbClient, getActiveDbInfo,
  type DatabaseProviderMode, type DbProbeResult,
} from "@/lib/db"
import { readDbActive, writeDbActive, clearDbActive, maskDbUrl, isDatabaseProvider, validateDbActiveConfig } from "@/lib/db-active"
import { requireAuth } from "@/lib/permissions"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"

// ============================================================
// r38：管理后台数据库管理（二次初始化 / 迁移 / 回滚 —— 管理员登录态强制）
//
// GET  /api/admin/database —— 状态总览：
//   · active（运行中客户端真实 provider/url + 探测）
//   · env（env 通道 provider/url）
//   · mismatch：env 类型/地址与运行库不一致 → 前端横幅「检测到数据库配置变更」
//   · migration：迁移子进程实时状态（phase/进度/日志）
//   · rollback：回滚可用性（prevProvider + rollbackUntil 窗口）
//   · 对账：state=done 且运行库 ≠ db-active → 自动 rebuildDbClient() 热切换
//
// POST /api/admin/database —— 动作（全部管理员登录态；迁移/回滚限超管）：
//   { action: "test",    provider, url }            连接测试（无副作用）
//   { action: "migrate", provider, url, retentionDays? }  二次初始化迁移（备份→结构→复制→校验→切换）
//   { action: "adopt",   provider, url }            直接采纳 env 新库（不迁移；目标须已有数据）
//   { action: "rollback" }                          回滚到迁移前数据库（源库原封未动）
// ============================================================

const ROOT = process.cwd()
const MIG_DIR = () => path.join(process.env.STORAGE_LOCAL_PATH || path.join(ROOT, "storage"), "db-migration")
const JOB_FILE = () => path.join(MIG_DIR(), "job.json")
const STATE_FILE = () => path.join(MIG_DIR(), "state.json")

interface MigrationStateFile {
  phase: "queued" | "backup" | "schema" | "clear" | "copy" | "verify" | "finalize" | "done" | "error"
  startedAt: string
  updatedAt: string
  error: string | null
  log: string[]
  progress: { table: string; tablesDone: number; tablesTotal: number; rowsCopied: number; rowsTotal: number; backupFiles: number }
  switchedAt?: string
}

function json(body: unknown, status = 200, traceId?: string) {
  const payload = status === 200 ? body : { ...((body ?? {}) as Record<string, unknown>), traceId }
  return NextResponse.json(payload, { status })
}

function readMigrationState(): MigrationStateFile | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE(), "utf8")) as MigrationStateFile
  } catch {
    return null
  }
}
function readMigrationJob(): { sourceProvider?: string; sourceUrl?: string; targetProvider?: string; targetUrl?: string } | null {
  try {
    return JSON.parse(readFileSync(JOB_FILE(), "utf8"))
  } catch {
    return null
  }
}
function migrationActive(st: MigrationStateFile | null): boolean {
  return !!st && ["queued", "backup", "schema", "clear", "copy", "verify", "finalize"].includes(st.phase)
}

// ---- GET：状态总览 + 完成对账 ----
export async function GET() {
  const traceId = crypto.randomUUID()
  const ctx = await requireAuth().catch(() => null)
  if (!ctx) return json({ code: 40100, msg: "未登录" }, 401, traceId)
  if (ctx.role !== "ADMIN" && ctx.role !== "SUPER_ADMIN") {
    return json({ code: 40300, msg: "仅管理员可查看数据库状态" }, 403, traceId)
  }

  try {
    const activeCfg = await readDbActive()
    const eff = effectiveDatabaseConfig()
    const activeInfo = getActiveDbInfo()
    const envProvider = databaseProvider()
    const envUrl = process.env.DATABASE_URL || ""
    const state = readMigrationState()
    const job = readMigrationJob()

    // ---- 完成对账：迁移 done 且运行库未切换 → 热切换（幂等；切换痕迹 switchedAt 落盘）----
    let switchedNow = false
    if (state && state.phase === "done" && activeCfg) {
      const same = activeInfo.provider === activeCfg.provider && activeInfo.url === activeCfg.url
      if (!same || !state.switchedAt) {
        if (!same) {
          await rebuildDbClient()
        }
        // 记录切换时间（幂等 —— 重复 GET 只补写字段，不重复 rebuild；tmp+rename 原子写防并发读半文件）
        if (!state.switchedAt) {
          try {
            const st = JSON.parse(readFileSync(STATE_FILE(), "utf8")) as MigrationStateFile
            st.switchedAt = new Date().toISOString()
            const tmpS = STATE_FILE() + ".tmp"
            writeFileSync(tmpS, JSON.stringify(st, null, 2))
            renameSync(tmpS, STATE_FILE())
          } catch {
            /* 状态补写失败无碍 */
          }
        }
        switchedNow = true
      }
    }

    // 运行库探测（连接健康度；连不上如实报）
    let probe: DbProbeResult | null = null
    try {
      probe = await probeDatabase(activeInfo.provider, activeInfo.url, 6000)
    } catch {
      probe = null
    }

    // mismatch 检测：env 与「当前运行库」的类型或地址不一致
    const envUrlMatchesActive = envUrl === activeInfo.url || (envProvider === activeInfo.provider && !envUrl)
    const mismatch = {
      detected: envProvider !== activeInfo.provider || (!!envUrl && !envUrlMatchesActive && envUrl !== activeInfo.url),
      envProvider,
      activeProvider: activeInfo.provider,
      envUrlMasked: envUrl ? maskDbUrl(envUrl) : "",
      activeUrlMasked: maskDbUrl(activeInfo.url),
      note:
        envProvider !== activeInfo.provider
          ? `env 数据库类型已从 ${activeInfo.provider} 改为 ${envProvider}：运行库保持原样（数据安全），请进入二次初始化模式完成迁移`
          : `env 数据库地址变更：运行库保持原样，如需切换请走二次初始化`,
    }

    // 回滚可用性
    const rollback = {
      available: !!activeCfg?.prevProvider && !!activeCfg?.prevUrl && (!activeCfg.rollbackUntil || new Date(activeCfg.rollbackUntil) > new Date()),
      prevProvider: activeCfg?.prevProvider ?? null,
      prevUrlMasked: activeCfg?.prevUrl ? maskDbUrl(activeCfg.prevUrl) : "",
      rollbackUntil: activeCfg?.rollbackUntil ?? null,
      migratedAt: activeCfg?.migratedAt ?? null,
      warning: "回滚将切回迁移前的原库（原数据完整保留）；迁移之后在新库上产生的数据不会自动同步回去",
    }

    return json({
      code: 0,
      data: {
        active: {
          provider: activeInfo.provider,
          urlMasked: maskDbUrl(activeInfo.url),
          source: eff.source,
          connectable: probe?.ok ?? false,
          version: probe?.version ?? "",
          latencyMs: probe?.latencyMs ?? 0,
          userCount: probe?.userCount ?? 0,
          probeError: probe?.error ?? null,
        },
        env: { provider: envProvider, urlMasked: envUrl ? maskDbUrl(envUrl) : "", configured: !!envUrl },
        mismatch,
        migration: state
          ? {
              phase: state.phase,
              running: migrationActive(state),
              progress: state.progress,
              error: state.error,
              startedAt: state.startedAt,
              updatedAt: state.updatedAt,
              switchedAt: state.switchedAt ?? null,
              target: job?.targetProvider ? { provider: job.targetProvider, urlMasked: maskDbUrl(String(job.targetUrl)) } : null,
              logTail: (state.log || []).slice(-8),
              backupDir: MIG_DIR(),
            }
          : null,
        rollback,
        switchedNow,
      },
    })
  } catch (e) {
    return json({ code: 50000, msg: e instanceof Error ? e.message : "状态查询失败" }, 500, traceId)
  }
}

// ---- POST：动作 ----
export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await requireAuth().catch(() => null)
  if (!ctx) return json({ code: 40100, msg: "未登录" }, 401, traceId)
  if (ctx.role !== "ADMIN" && ctx.role !== "SUPER_ADMIN") {
    return json({ code: 40300, msg: "仅管理员可执行数据库操作" }, 403, traceId)
  }
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    provider?: string
    url?: string
    retentionDays?: number
  }
  const action = String(body.action || "")

  try {
    // ================= test：连接测试（无副作用） =================
    if (action === "test") {
      const provider = String(body.provider || "")
      if (!isDatabaseProvider(provider)) return json({ code: 40001, msg: "provider 必须为 sqlite / postgres / mysql" }, 400, traceId)
      const url = String(body.url || "").trim()
      if (!providerUrlMatchesSafe(provider, url)) return json({ code: 40002, msg: `url 协议与 ${provider} 不匹配` }, 400, traceId)
      const probe = await probeDatabase(provider, url, 8000)
      return json({ code: 0, data: { probe } })
    }

    // ================= migrate：二次初始化迁移（仅超管） =================
    if (action === "migrate") {
      if (ctx.role !== "SUPER_ADMIN") return json({ code: 40300, msg: "数据库迁移仅超级管理员可执行" }, 403, traceId)

      const provider = String(body.provider || "")
      if (!isDatabaseProvider(provider)) return json({ code: 40001, msg: "provider 必须为 sqlite / postgres / mysql" }, 400, traceId)
      const url = String(body.url || "").trim()
      const { ok: cfgOk, errors, clean } = validateDbActiveConfig({ provider, url })
      if (!cfgOk || !clean) return json({ code: 40002, msg: errors.join("；") }, 400, traceId)

      // 迁移互斥：已有迁移在跑
      const cur = readMigrationState()
      if (migrationActive(cur)) {
        return json({ code: 40900, msg: "已有迁移正在进行（phase=" + cur?.phase + "），请等待完成或刷新查看进度" }, 409, traceId)
      }

      // 目标不能是当前运行库自己
      const activeInfo = getActiveDbInfo()
      if (activeInfo.provider === clean.provider && activeInfo.url === clean.url) {
        return json({ code: 40003, msg: "目标数据库即当前运行库，无需迁移" }, 400, traceId)
      }

      // 目标可达性预检（失败即拒 —— 杜绝中途才发现连不上）
      const probe = await probeDatabase(clean.provider, clean.url, 8000)
      if (!probe.ok) {
        return json({ code: 40004, msg: `目标数据库无法连接：${probe.error}`, data: { probe } }, 400, traceId)
      }

      // 写 job + 初始 state，spawn 迁移子进程
      mkdirSync(MIG_DIR(), { recursive: true })
      const retentionDays = Math.min(Math.max(Number(body.retentionDays) || 7, 1), 90)
      const backupDir = path.join(MIG_DIR(), "backup-" + Date.now())
      const job = {
        sourceProvider: activeInfo.provider,
        sourceUrl: activeInfo.url,
        targetProvider: clean.provider,
        targetUrl: clean.url,
        stateFile: STATE_FILE(),
        backupDir,
        retentionDays,
      }
      writeFileSync(JOB_FILE(), JSON.stringify(job, null, 2))
      const initialState: MigrationStateFile = {
        phase: "queued",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        log: [],
        progress: { table: "", tablesDone: 0, tablesTotal: 0, rowsCopied: 0, rowsTotal: 0, backupFiles: 0 },
      }
      const tmp = STATE_FILE() + ".tmp"
      writeFileSync(tmp, JSON.stringify(initialState, null, 2))
      renameSync(tmp, STATE_FILE())

      const script = path.join(ROOT, "scripts", "db", "migrate-provider.ts")
      if (!existsSync(script)) {
        return json({ code: 50001, msg: `迁移引擎脚本缺失：${script}` }, 500, traceId)
      }
      const child = spawn("bun", [script, "--job", JOB_FILE()], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      })
      child.unref()

      try {
        await writeAudit({
          operatorUserId: ctx.userId,
          operatorName: ctx.username,
          operationType: "DB_MIGRATION_START",
          resourceType: "SYSTEM",
          resourceId: clean.provider,
          resourceName: `数据库迁移 ${activeInfo.provider} → ${clean.provider}`,
          severity: "CRITICAL",
          ip: clientIp,
          before: { provider: activeInfo.provider, url: maskDbUrl(activeInfo.url) },
          after: { provider: clean.provider, url: maskDbUrl(clean.url), backupDir, retentionDays, pid: child.pid },
        })
      } catch {
        /* 尽力而为 */
      }

      return json({
        code: 0,
        msg: "迁移已启动（备份 → 结构 → 复制 → 校验 → 切换；全程源库只读零修改）",
        data: { pid: child.pid, backupDir, stateFile: STATE_FILE() },
      })
    }

    // ================= adopt：直接采纳 env 新库（不迁移；仅超管） =================
    if (action === "adopt") {
      if (ctx.role !== "SUPER_ADMIN") return json({ code: 40300, msg: "数据库采纳仅超级管理员可执行" }, 403, traceId)
      const provider = String(body.provider || "")
      const url = String(body.url || "").trim()
      const { ok: cfgOk, errors, clean } = validateDbActiveConfig({ provider, url })
      if (!cfgOk || !clean) return json({ code: 40002, msg: errors.join("；") }, 400, traceId)

      const probe = await probeDatabase(clean.provider, clean.url, 8000)
      if (!probe.ok) return json({ code: 40003, msg: `目标数据库无法连接：${probe.error}` }, 400, traceId)
      if (!probe.hasData) {
        return json({ code: 40004, msg: "目标库无业务数据（采纳将得到空库）；如需从当前库搬运数据请使用「迁移」" }, 400, traceId)
      }

      const activeInfo = getActiveDbInfo()
      await writeDbActive({ ...clean, prevProvider: activeInfo.provider, prevUrl: activeInfo.url, initSource: "migrate", migratedAt: new Date().toISOString(), rollbackUntil: new Date(Date.now() + 7 * 86400_000).toISOString() })
      const rebuilt = await rebuildDbClient()
      try {
        await writeAudit({
          operatorUserId: ctx.userId, operatorName: ctx.username,
          operationType: "DB_ADOPT", resourceType: "SYSTEM", resourceId: rebuilt.provider,
          resourceName: "直接采纳新数据库（不迁移）", severity: "CRITICAL", ip: clientIp,
          before: { provider: activeInfo.provider, url: maskDbUrl(activeInfo.url) },
          after: { provider: rebuilt.provider, url: maskDbUrl(rebuilt.url) },
        })
      } catch { /* 尽力而为 */ }
      return json({ code: 0, msg: "已切换到目标数据库（未迁移数据）", data: { provider: rebuilt.provider, urlMasked: maskDbUrl(rebuilt.url) } })
    }

    // ================= rollback：回滚（仅超管） =================
    if (action === "rollback") {
      if (ctx.role !== "SUPER_ADMIN") return json({ code: 40300, msg: "回滚仅超级管理员可执行" }, 403, traceId)
      const cur = readMigrationState()
      if (migrationActive(cur)) {
        return json({ code: 40900, msg: "迁移正在进行，不能回滚（请等待完成或处理失败态）" }, 409, traceId)
      }
      const activeCfg = await readDbActive()
      if (!activeCfg?.prevProvider || !activeCfg?.prevUrl) {
        return json({ code: 40005, msg: "无可回滚记录（当前库不是迁移/采纳目标）" }, 400, traceId)
      }
      if (activeCfg.rollbackUntil && new Date(activeCfg.rollbackUntil) < new Date()) {
        return json({ code: 40006, msg: "回滚窗口已过期（原库连接串已清理）" }, 400, traceId)
      }
      // 原库可达性预检
      const probe = await probeDatabase(activeCfg.prevProvider, activeCfg.prevUrl, 8000)
      if (!probe.ok) {
        return json({ code: 40007, msg: `迁移前数据库无法连接：${probe.error}`, data: { probe } }, 400, traceId)
      }

      const activeInfo = getActiveDbInfo()
      await writeDbActive({
        provider: activeCfg.prevProvider,
        url: activeCfg.prevUrl,
        prevProvider: null,
        prevUrl: null,
        migratedAt: undefined,
        rollbackUntil: null,
        initSource: "migrate",
        updatedBy: `rollback:${ctx.username}`,
      })
      const rebuilt = await rebuildDbClient()
      try {
        await writeAudit({
          operatorUserId: ctx.userId, operatorName: ctx.username,
          operationType: "DB_ROLLBACK", resourceType: "SYSTEM", resourceId: rebuilt.provider,
          resourceName: "数据库迁移回滚", severity: "CRITICAL", ip: clientIp,
          before: { provider: activeInfo.provider, url: maskDbUrl(activeInfo.url) },
          after: { provider: rebuilt.provider, url: maskDbUrl(rebuilt.url) },
        })
        await writeSecurityEvent({
          userId: ctx.userId, username: ctx.username, eventType: "DB_ROLLBACK", success: true, ip: clientIp,
          detail: `数据库回滚：${activeInfo.provider} → ${rebuilt.provider}（原库数据原封未动）`,
        })
      } catch { /* 尽力而为 */ }
      return json({ code: 0, msg: "已回滚到迁移前数据库（原数据完整）", data: { provider: rebuilt.provider, urlMasked: maskDbUrl(rebuilt.url) } })
    }

    return json({ code: 40000, msg: `未知 action：${action}（支持 test / migrate / adopt / rollback）` }, 400, traceId)
  } catch (e) {
    try {
      await writeSecurityEvent({
        userId: ctx.userId, username: ctx.username, eventType: "DB_ADMIN_OP_FAIL", success: false, ip: clientIp,
        detail: `数据库操作失败（${action}）：${e instanceof Error ? e.message : String(e)}`,
      })
    } catch { /* 忽略 */ }
    return json({ code: 50000, msg: e instanceof Error ? e.message : "操作失败" }, 500, traceId)
  }
}

function providerUrlMatchesSafe(provider: string, url: string): boolean {
  if (provider === "sqlite") return url.startsWith("file:") || url === "" || !url.includes("://")
  if (provider === "postgres") return /^postgres(ql)?:\/\//.test(url)
  if (provider === "mysql") return /^mysql:\/\//.test(url)
  return false
}
