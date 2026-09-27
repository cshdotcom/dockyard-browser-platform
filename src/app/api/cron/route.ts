import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { runTask, runningTaskCodes, TASKS } from "@/server/tasks/engine"
import { ENV } from "@/lib/env"

// 受保护定时任务触发接口：外部 cron 调用
// 鉴权：x-cron-secret 头部校验内部访问密钥，拒绝外部请求
// GET /api/cron?task=all|<code>  批量或单个执行
// POST /api/cron {taskCode}      手动执行（同样施加内存锁）

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
  const results: { code: string; ok: boolean; message: string }[] = []

  const enabledTasks = await db.scheduleTask.findMany({ where: { enabled: true } })
  const codes = task === "all" ? enabledTasks.map((t) => t.code) : [task]

  for (const code of codes) {
    if (!TASKS[code]) continue
    const r = await runTask(code, "CRON")
    results.push({ code, ...r })
  }
  return NextResponse.json({ code: 0, msg: "ok", data: { results, running: runningTaskCodes() }, traceId })
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  if (!authorized(req)) {
    return NextResponse.json({ code: 40300, msg: "拒绝访问：内部受保护接口", traceId }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as { taskCode?: string }
  if (!body.taskCode || !TASKS[body.taskCode]) {
    return NextResponse.json({ code: 40001, msg: "缺少或未知 taskCode", traceId })
  }
  const r = await runTask(body.taskCode, "MANUAL")
  return NextResponse.json({ code: r.ok ? 0 : 50000, msg: r.message, traceId })
}
