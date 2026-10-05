import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import path from "node:path"
import { db, databaseProvider, effectiveDatabaseConfig, probeDatabase, rebuildDbClient, type DatabaseProviderMode, type DbProbeResult } from "@/lib/db"
import { readDbActive, writeDbActive, validateDbActiveConfig, maskDbUrl, providerUrlMatches, isDatabaseProvider } from "@/lib/db-active"
import { getBootstrapState, setupTokenHint, verifySetupToken } from "@/lib/bootstrap"
import { writeAudit, writeSecurityEvent } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs"

// ============================================================
// r38：安装向导数据库配置（首启绑定 / env 自动检测 / 灾难恢复重绑）
//
// GET  /api/setup/database —— 向导状态：
//   · env 已配置且可连接（有结构或可初始化）→ needsDbBinding=false（跳过绑定步骤）
//   · env 未配置（默认 sqlite）→ needsDbBinding=false（零依赖开箱即用；可展开高级绑定）
//   · env 配置但连不上 → needsDbBinding=true（表单预填 env 值 + 错误提示）
//   · 附带：当前库探测（结构/数据/用户数）+ 管理员状态 + setup token 提示
//
// POST /api/setup/database —— 绑定 + 初始化：
//   body: { provider, url, setupToken }
//   门禁：库中无管理员（首装）OR setupToken 有效（灾难恢复通道 —— 运维从
//         启动日志/数据目录 storage/setup-token.txt 取当前进程密钥）
//   流程：校验 → 探测 →（无结构时）db push + seed（SEED_SKIP_ADMIN：env 无
//         ADMIN_* 时不播种默认密码账号，由向导第二步创建）→ 写 db-active.json
//         （initSource=setup）→ rebuildDbClient() 热切换 → 审计
// ============================================================

const ROOT = process.cwd()

function json(body: unknown, status = 200, traceId?: string) {
  const payload = status === 200 ? body : { ...((body ?? {}) as Record<string, unknown>), traceId }
  return NextResponse.json(payload, { status })
}

// ---- 初始化子进程（db push + seed）----
interface InitResult { ok: boolean; log: string; error?: string }

function runCmd(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } as NodeJS.ProcessEnv })
    let out = ""
    p.stdout?.on("data", (d: Buffer) => (out += d.toString()))
    p.stderr?.on("data", (d: Buffer) => (out += d.toString()))
    p.on("error", (e) => resolve({ code: -1, out: `启动失败：${e.message}` }))
    p.on("close", (code) => resolve({ code, out }))
  })
}

async function initializeSchema(provider: DatabaseProviderMode, url: string, opts: { skipAdmin: boolean }): Promise<InitResult> {
  const schemaFile = provider === "sqlite" ? "prisma/schema.prisma" : `prisma/schema.${provider}.prisma`
  const seedFile = provider === "sqlite" ? "prisma/seed.ts" : `prisma/seed-${provider}.ts`
  const dbEnv = { DATABASE_PROVIDER: provider, DATABASE_URL: url }

  // 1. db push（结构；幂等）
  const push = await runCmd("bunx", ["prisma", "db", "push", "--schema", schemaFile, "--skip-generate", "--accept-data-loss"], dbEnv)
  if (push.code !== 0) {
    return { ok: false, log: push.out, error: `结构初始化失败（prisma db push exit=${push.code}）：${push.out.slice(-500)}` }
  }

  // 2. seed（配置/定时任务/模板；SEED_SKIP_ADMIN=1 时不播账号）
  const seedEnv = { ...dbEnv, ...(opts.skipAdmin ? { SEED_SKIP_ADMIN: "1", SEED_DEMO: "0" } : {}) }
  const seed = await runCmd("bun", [seedFile], seedEnv)
  if (seed.code !== 0) {
    return { ok: false, log: push.out + "\n--- seed ---\n" + seed.out, error: `种子数据失败（bun ${seedFile} exit=${seed.code}）：${seed.out.slice(-500)}` }
  }
  return { ok: true, log: push.out + "\n--- seed ---\n" + seed.out }
}

// ---- GET：向导状态 ----
export async function GET() {
  const traceId = crypto.randomUUID()
  try {
    const eff = effectiveDatabaseConfig()
    const activeCfg = await readDbActive()
    const envProvider = databaseProvider()
    const envUrl = process.env.DATABASE_URL || ""
    const envConfigured = !!(envUrl && providerUrlMatches(envProvider, envUrl) && (envProvider !== "sqlite" || envUrl.startsWith("file:")))

    // 当前生效库探测（连不上/无结构都如实上报 —— 向导据此决策）
    let probe: DbProbeResult | null = null
    try {
      probe = await probeDatabase(eff.provider, eff.url, 6000)
    } catch {
      probe = null
    }

    let bootstrap: Awaited<ReturnType<typeof getBootstrapState>> | null = null
    try {
      bootstrap = await getBootstrapState()
    } catch {
      bootstrap = null // 库不可达时管理员状态未知（向导按 needsDbBinding 处理）
    }

    // 绑定需求判定：
    // · 生效库连不上且 env 有显式其它配置 → 必须绑定（修 env 错误配置）
    // · 生效库连不上且 env 无配置 → 默认 sqlite 理论总能连；仍失败 → 绑定表单（换库）
    // · 生效库连得上 → 不需绑定（env 自动初始化路径 or db-active 已就绪）
    const connectable = probe?.ok === true
    const needsDbBinding = !connectable

    return json({
      code: 0,
      data: {
        needsDbBinding,
        active: {
          provider: eff.provider,
          source: eff.source,
          urlMasked: maskDbUrl(eff.url),
          connectable,
          hasSchema: probe?.hasSchema ?? false,
          hasData: probe?.hasData ?? false,
          userCount: probe?.userCount ?? 0,
          version: probe?.version ?? "",
          latencyMs: probe?.latencyMs ?? 0,
          probeError: probe?.error ?? null,
        },
        env: {
          provider: envProvider,
          urlMasked: envUrl ? maskDbUrl(envUrl) : "",
          configured: envConfigured,
        },
        dbActive: activeCfg
          ? { provider: activeCfg.provider, urlMasked: maskDbUrl(activeCfg.url), initSource: activeCfg.initSource ?? "", prevProvider: activeCfg.prevProvider ?? null, rollbackUntil: activeCfg.rollbackUntil ?? null }
          : null,
        hasAdmin: bootstrap?.hasAdmin ?? false,
        userCount: bootstrap?.userCount ?? 0,
        setupTokenHint: bootstrap?.needsSetup ? setupTokenHint() : "",
      },
    })
  } catch (e) {
    return json({ code: 50000, msg: e instanceof Error ? e.message : "状态查询失败" }, 500, traceId)
  }
}

// ---- POST：绑定 + 初始化 ----
export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  try {
    const body = (await req.json().catch(() => ({}))) as {
      provider?: string
      url?: string
      setupToken?: string
    }

    // ---- 门禁：首装（无管理员）或 setupToken（灾难恢复）----
    let bootstrap: Awaited<ReturnType<typeof getBootstrapState>>
    try {
      bootstrap = await getBootstrapState()
    } catch {
      // 库不可达 —— 视为首装形态（当前库无法提供管理员状态）
      bootstrap = { hasAdmin: false, userCount: 0, needsSetup: true, setupTokenRequired: true, setupTokenHint: setupTokenHint() }
    }
    const tokenOk = body.setupToken ? verifySetupToken(body.setupToken) : false
    if (bootstrap.hasAdmin && !tokenOk) {
      return json({ code: 40300, msg: "系统已初始化：重绑数据库需管理员在后台操作，或提供当前进程的 Setup Token（见启动日志 / storage/setup-token.txt）" }, 403, traceId)
    }

    // ---- 参数校验 ----
    const provider = String(body.provider || "")
    if (!isDatabaseProvider(provider)) {
      return json({ code: 40001, msg: "provider 必须为 sqlite / postgres / mysql" }, 400, traceId)
    }
    const url = String(body.url || "").trim()
    const { ok: cfgOk, errors, clean } = validateDbActiveConfig({ provider, url })
    if (!cfgOk || !clean) {
      return json({ code: 40002, msg: errors.join("；") }, 400, traceId)
    }

    // ---- 探测目标 ----
    const probe = await probeDatabase(provider, url, 8000)
    if (!probe.ok) {
      return json({ code: 40003, msg: `无法连接目标数据库：${probe.error}`, data: { probe } }, 400, traceId)
    }
    // 安全门：非首装（token 恢复通道）且目标库有他人数据 → 拒绝（防误绑覆盖）
    if (bootstrap.hasAdmin && probe.hasData) {
      return json({ code: 40004, msg: "目标数据库已有业务数据：请改用管理后台的「数据库迁移（二次初始化）」流程，避免直接覆盖" }, 400, traceId)
    }

    // ---- 无结构 → 初始化（push + seed）----
    let initLog = ""
    if (!probe.hasSchema) {
      const envHasAdmin = !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD)
      const init = await initializeSchema(provider, url, { skipAdmin: !envHasAdmin })
      if (!init.ok) {
        return json({ code: 50001, msg: init.error || "初始化失败", data: { log: init.log.slice(-2000) } }, 500, traceId)
      }
      initLog = init.log
    }

    // ---- 写 db-active.json + 热切换 ----
    await writeDbActive({ ...clean, initSource: "setup", updatedBy: "setup-wizard" })
    const rebuilt = await rebuildDbClient()

    // ---- 审计（写新库；写失败不影响主流程）----
    try {
      await writeAudit({
        operationType: "DB_SETUP_BIND",
        resourceType: "SYSTEM",
        resourceId: provider,
        resourceName: `数据库绑定（${provider}）`,
        severity: "WARN",
        ip: clientIp,
        after: { provider, url: maskDbUrl(url), hadSchema: probe.hasSchema, initLogLen: initLog.length },
      })
      await writeSecurityEvent({
        eventType: "DB_SETUP_BIND",
        success: true,
        ip: clientIp,
        detail: `安装向导绑定数据库 ${provider}（${maskDbUrl(url)}），结构${probe.hasSchema ? "已存在" : "已初始化"}，运行时已热切换`,
      })
    } catch {
      /* 审计尽力而为 */
    }

    return json({
      code: 0,
      msg: "数据库绑定成功",
      data: {
        provider: rebuilt.provider,
        urlMasked: maskDbUrl(rebuilt.url),
        initializedSchema: !probe.hasSchema,
        seedSkippedAdmin: !probe.hasSchema && !(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD),
        nextStep: "admin-create",
      },
    })
  } catch (e) {
    try {
      await writeSecurityEvent({
        eventType: "DB_SETUP_BIND",
        success: false,
        ip: clientIp,
        detail: `数据库绑定失败：${e instanceof Error ? e.message : String(e)}`,
      })
    } catch {
      /* 忽略 */
    }
    return json({ code: 50000, msg: e instanceof Error ? e.message : "绑定失败" }, 500, traceId)
  }
}
