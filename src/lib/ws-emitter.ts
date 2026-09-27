// WS 枢纽事件推送：主服务业务事件 → ws-hub（3004/emit）→ 按房间广播
// 用途：告警站内推送 / 管理员强制操作通知 / 会话状态变更 / 实例日志

const HUB_EMIT_URL = process.env.WS_HUB_EMIT_URL || "http://127.0.0.1:3004/emit"
const HUB_SECRET = process.env.CRON_SECRET || "dockyard-cron-secret-dev"

export async function hubEmit(event: string, payload: unknown, room?: string): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(HUB_EMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-secret": HUB_SECRET },
      body: JSON.stringify({ event, room: room || "all", payload }),
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    // WS枢纽不可用不阻塞业务
    return false
  }
}

// 便捷方法：推送告警给指定用户
export function emitNoticeToUser(userId: string, notice: { title: string; content: string; level?: string }) {
  return hubEmit("notice", notice, `user:${userId}`)
}

// 便捷方法：管理员强制操作通知（用户前端弹窗提示）
export function emitForceAction(userId: string, action: string, resource: { type: string; name: string }) {
  return hubEmit("force-action", { action, ...resource, message: `管理员已${action}「${resource.name}」`, at: new Date().toISOString() }, `user:${userId}`)
}

// 会话状态变更广播
export function emitSessionChange(workspaceId: string, status: string, extra?: Record<string, unknown>) {
  return hubEmit("session-status", { workspaceId, status, ...extra }, `res:WORKSPACE:${workspaceId}`)
}
