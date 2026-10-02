import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { runTask, runningTaskCodes, TASKS } from "@/server/tasks/engine"
import { ENV } from "@/lib/env"
import { nextCronRun } from "@/lib/cron-next"

// 受保护定时任务触发接口：外部 cron / 内置调度器调用
// 鉴权：x-cron-secret 头部校验内部访问密钥，拒绝外部请求
// GET /api/cron?task=all        —— r23：按 cron 表达式到期判定，只执行到期任务
// GET /api/cron?task=<code>     —— 强制执行指定任务（无视到期）
// GET /api/cron?task=all&force=1 —— 全量强制执行（运维通道，兼容旧固频行为）
// POST /api/cron {taskCode}      —— 手动执行（同样施加内存锁）

function authorized(req: NextRequest): boolean {
  const secret = req.headers.get("x-cron-secret") || req.nextUrl.searchParams.get("secret")
  return secret === ENV.cronSecret
}

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  if (!authorized(req)) {
    return NextResponse.json({ code: 40300, msg: "拒绝访问：内部受保护接口", traceId }, { status: 403 })
  }
  const task = req.nextUrl.searchParams.get("task") || "all"
  const force = req.nextUrl.searchParams.get("force") === "1"
  const results: { code: string; ok: boolean; message: string }[] = []

  const enabledTasks = await db.scheduleTask.findMany({ where: { enabled: true } })
  const now = Date.now()

  if (task === "all" && !force) {
    // ---- r23：到期判定（nextRunAt <= now 即到期；nextRunAt 为空的任务视为到期兜底） ----
    // 执行前先把 nextRunAt 推进到下一次（防同分钟内多路触发器并发重复入队；内存锁仍兜底）
    const due: string[] = []
    for (const t of enabledTasks) {
      const isDue = !t.nextRunAt || t.nextRunAt.getTime() <= now
      if (!isDue) continue
      // 校验执行体存在（自定义任务指向的 taskType 必须在注册表中）
      const execCode = t.isCustom && t.taskType ? t.taskType : t.code
      if (!TASKS[execCode]) continue
      const next = nextCronRun(t.cronExpr, new Date())
      await db.scheduleTask.update({ where: { code: t.code }, data: next ? { nextRunAt: next } : {} }).catch(() => {})
      due.push(t.code)
    }
    for (const code of due) {
      const r = await runTask(code, "CRON")
      results.push({ code, ...r })
    }
    return NextResponse.json({ code: 0, msg: "ok", data: { due, executed: results.length, results, running: runningTaskCodes(), traceId } })
  }

  // 指定任务 / force 全量
  const codes = task === "all" ? enabledTasks.map((t) => t.code) : [task]
  for (const code of codes) {
    const row = await db.scheduleTask.findUnique({ where: { code } })
    const execCode = row?.isCustom && row.taskType ? row.taskType : code
    if (!TASKS[execCode]) continue
    const r = await runTask(code, "CRON")
    results.push({ code, ...r })
  }
  return NextResponse.json({ code: 0, msg: "ok", data: { results, running: runningTaskCodes(), traceId } })
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  if (!authorized(req)) {
    return NextResponse.json({ code: 40300, msg: "拒绝访问：内部受保护接口", traceId }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { taskCode?: string }
  if (!body.taskCode) {
    return NextResponse.json({ code: 40001, msg: "缺少 taskCode", traceId })
  }
  // r23：自定义任务 code 形如 custom:xxx，执行体经 taskType 解析
  const row = await db.scheduleTask.findUnique({ where: { code: body.taskCode } })
  const execCode = row?.isCustom && row.taskType ? row.taskType : body.taskCode
  if (!TASKS[execCode]) {
    return NextResponse.json({ code: 40001, msg: "未知任务或任务类型不存在", traceId })
  }
  const r = await runTask(body.taskCode, "MANUAL")
  return NextResponse.json({ code: r.ok ? 0 : 50000, msg: r.message, traceId })
}
