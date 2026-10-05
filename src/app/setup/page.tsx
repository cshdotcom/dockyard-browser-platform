import { redirect } from "next/navigation"
import { getConfig } from "@/lib/config"
import { getBootstrapState } from "@/lib/bootstrap"
import { SetupWizard } from "./setup-wizard"

// 首次启动安装向导（r38 两步流：数据库绑定 → 管理员创建）
// · 库中已有管理员时自动跳转登录（env ADMIN_* 预置账号同理）
// · 数据库绑定策略见 database-binding-step.tsx：
//   env 已配置且可连接 → 跳过绑定直接创建管理员（用户要求「env 配置好
//   且连接成功可写入就直接自动初始化，只询问创建管理员」）；
//   连不上 → 强制绑定（表单预填 env 值）；
//   未配置 → 默认 SQLite 开箱即用（可展开高级绑定）
export const dynamic = "force-dynamic"

export const metadata = { title: "初始化向导" }

export default async function SetupPage() {
  const state = await getBootstrapState()
  if (state.hasAdmin) redirect("/login?notice=bootstrap-done")

  const siteName = await getConfig<string>("ui.siteName", "Dockyard 浏览器工作平台")

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/40 dark:via-background dark:to-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-teal-600 flex items-center justify-center text-white font-bold text-xl">D</div>
          <h1 className="text-2xl font-semibold tracking-tight">初始化向导</h1>
          <p className="text-sm text-muted-foreground">{siteName} · 首次启动引导（数据库 + 管理员）</p>
        </div>

        <SetupWizard tokenHint={state.setupTokenHint} siteName={siteName} />

        <p className="text-center text-xs text-muted-foreground">
          已有管理员？<a href="/login" className="text-teal-600 hover:underline">直接登录</a>
        </p>
      </div>
    </div>
  )
}
