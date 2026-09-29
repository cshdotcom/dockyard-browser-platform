// 工作区生命周期追踪：运行时长（累计+当前段）与最近活跃
// 全部尽力而为（.catch 兜底），绝不阻断业务主链路。
// 数据模型：startedAt（最近启动）+ runtimeAccumSec（累计秒）+ lastActiveAt（最近活跃）
// 有效运行时长 = runtimeAccumSec + (RUNNING/IDLE 时 now - startedAt)

import { db } from "@/lib/db"

export async function markWorkspaceStarted(id: string): Promise<void> {
  await db.browserWorkspace
    .update({ where: { id }, data: { startedAt: new Date() } })
    .catch(() => {})
}

export async function markWorkspaceStopped(id: string): Promise<void> {
  const ws = await db.browserWorkspace
    .findUnique({ where: { id }, select: { startedAt: true } })
    .catch(() => null)
  if (!ws) return
  if (!ws.startedAt) {
    await db.browserWorkspace.update({ where: { id }, data: { startedAt: null } }).catch(() => {})
    return
  }
  const delta = Math.max(0, Math.floor((Date.now() - ws.startedAt.getTime()) / 1000))
  await db.browserWorkspace
    .update({ where: { id }, data: { runtimeAccumSec: { increment: delta }, startedAt: null } })
    .catch(() => {})
}

export async function touchWorkspaceActive(id: string): Promise<void> {
  await db.browserWorkspace
    .update({ where: { id }, data: { lastActiveAt: new Date() } })
    .catch(() => {})
}

// 有效运行时长（秒）：累计 + 当前运行段
export function effectiveRuntimeSec(ws: {
  status: string
  startedAt: Date | null
  runtimeAccumSec: number
}): number {
  const live =
    ws.startedAt && (ws.status === "RUNNING" || ws.status === "IDLE")
      ? Math.floor((Date.now() - ws.startedAt.getTime()) / 1000)
      : 0
  return (ws.runtimeAccumSec || 0) + Math.max(0, live)
}

// 秒数 → 人读时长（"3天4小时" / "2小时15分" / "36分" / "45秒"）
export function fmtRuntime(sec: number): string {
  if (!sec || sec < 1) return "—"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分`
  return `${sec}秒`
}
