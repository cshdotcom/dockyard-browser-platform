// ============================================================
// r23：Next.js 服务进程内置调度器（instrumentation register 钩子）
// · 进程启动 15s 后开始，每 60s 扫描一次 ScheduleTask 表：
//   nextRunAt 到期（或为空兜底）且 enabled 的任务直接调用 runTask
// · cron 表达式语义真正的调度器：不再依赖固定 300s 全量触发
// · 与 docker start.sh 内置 wget 心跳（task=all 到期判定）兼容并存：
//   双通道都会先推进 nextRunAt 再入队，且 runTask 有内存锁防重入
// · BUILTIN_CRON=0 环境变量（外部自管 cron 场景）同样禁用本调度器
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  if (process.env.BUILTIN_CRON === "0") return
  if (process.env.DISABLE_INPROC_SCHEDULER === "1") return

  const tickIntervalSec = Number(process.env.CRON_TICK_SEC || 60)
  const started = Date.now() + 15_000 // 等主服务与 DB 就绪

  const tick = async () => {
    try {
      // 动态导入：避免在 instrumentation 上下文过早加载 Prisma
      const [{ db }, engine, { nextCronRun }] = await Promise.all([
        import("@/lib/db"),
        import("@/server/tasks/engine"),
        import("@/lib/cron-next"),
      ])
      const enabled = await db.scheduleTask.findMany({ where: { enabled: true }, select: { code: true, cronExpr: true, nextRunAt: true, isCustom: true, taskType: true } })
      const now = Date.now()
      for (const t of enabled) {
        const isDue = !t.nextRunAt || t.nextRunAt.getTime() <= now
        if (!isDue) continue
        const execCode = t.isCustom && t.taskType ? t.taskType : t.code
        if (!engine.TASKS[execCode]) continue
        // 先推进 nextRunAt（防同分钟重复入队），执行由内存锁兜底
        const next = nextCronRun(t.cronExpr, new Date())
        await db.scheduleTask.update({ where: { code: t.code }, data: next ? { nextRunAt: next } : {} }).catch(() => {})
        // 顺序执行（避免并行任务打满 CPU；任务本身带超时保护）
        await engine.runTask(t.code, "CRON").catch(() => {})
      }
    } catch {
      // DB 未就绪 / 模块加载失败：静默重试下一轮
    }
  }

  const loop = () => {
    if (Date.now() >= started) void tick()
    setTimeout(loop, tickIntervalSec * 1000)
  }
  setTimeout(loop, Math.max(1_000, started - Date.now()))
  console.log(`[instrumentation] 内置 cron 调度器已注册（tick=${tickIntervalSec}s，BUILTIN_CRON=0 可关闭）`)
}
