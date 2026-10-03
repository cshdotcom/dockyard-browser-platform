import { requireAdmin } from "@/lib/permissions"
import { MonitorCenterPanel } from "./monitor-center-panel"

// ============================================================
// r29-c：实时监控中心（16 宫格轮巡 + 远程操作 + 双模式监控授权）
// ADMIN+ 可观看与授权知情模式；静默特权仅超管（action 层校验）
// ============================================================
export const metadata = { title: "实时监控中心" }

export default async function AdminMonitorPage() {
  const ctx = await requireAdmin()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">实时监控中心</h1>
        <p className="text-sm text-muted-foreground mt-1">
          16 宫格沙箱画面轮巡（5-60s）/ CDP 快照 / 远程键鼠注入（管理员互斥）/ 强制跳转 / 关标签 / 消息推送 / 会话中断；
          硬件监视双模式：知情模式（用户横幅+一键切断）与静默特权模式（仅超管，强制审计）
        </p>
      </div>
      <MonitorCenterPanel canSilent={ctx.role === "SUPER_ADMIN"} adminName={ctx.username} />
    </div>
  )
}
