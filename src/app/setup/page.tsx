import { redirect } from "next/navigation"
import { getConfig } from "@/lib/config"
import { getBootstrapState } from "@/lib/bootstrap"
import { SetupForm } from "./setup-form"

// 首次启动管理员引导页：库中已有管理员时自动跳转登录
// 管理员也可经配置文件（ADMIN_* 环境变量，start.sh seed）注册；后期可随时在账号安全页修改
export const dynamic = "force-dynamic"

export const metadata = { title: "初始化管理员" }

export default async function SetupPage() {
  const state = await getBootstrapState()
  if (state.hasAdmin) redirect("/login?notice=bootstrap-done")

  const siteName = await getConfig<string>("ui.siteName", "Dockyard 浏览器工作平台")

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/40 dark:via-background dark:to-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-teal-600 flex items-center justify-center text-white font-bold text-xl">D</div>
          <h1 className="text-2xl font-semibold tracking-tight">初始化管理员账号</h1>
          <p className="text-sm text-muted-foreground">{siteName} · 首次启动引导</p>
        </div>

        <div className="rounded-lg border border-teal-200 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/40 p-3 text-sm text-teal-800 dark:text-teal-200 space-y-1">
          <p className="font-medium">系统尚未创建任何管理员账号</p>
          <p className="text-xs leading-relaxed">
            请在此注册第一个超级管理员（创建后本引导页将永久关闭）。也可在部署时通过环境变量
            <code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px]">ADMIN_USERNAME</code>
            <code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px]">ADMIN_PASSWORD</code>
            自动完成注册。管理员账号后期可在「账号与安全」页面修改用户名、邮箱与密码。
          </p>
          <p className="text-xs leading-relaxed border-t border-teal-200/60 dark:border-teal-800/60 pt-1.5">
            <span className="font-medium">启动密钥：</span>注册需输入本次服务启动生成的 Setup Token
            （管理员初始化完成前每次重启都会变化，当前提示 <code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px] font-semibold">{state.setupTokenHint || "-"}</code>）。
            完整密钥在服务器控制台启动日志或数据目录 <code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px]">storage/setup-token.txt</code>，
            也可用环境变量 <code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px]">SETUP_TOKEN</code> 固定指定。
          </p>
        </div>

        <SetupForm tokenHint={state.setupTokenHint} />

        <p className="text-center text-xs text-muted-foreground">
          已有管理员？<a href="/login" className="text-teal-600 hover:underline">直接登录</a>
        </p>
      </div>
    </div>
  )
}
