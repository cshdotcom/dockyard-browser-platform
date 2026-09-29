import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getConfig } from "@/lib/config"
import { getBootstrapState } from "@/lib/bootstrap"
import { getAuthContext } from "@/lib/permissions"
import { LoginForm } from "./login-form"

export const dynamic = "force-dynamic"

export const metadata = { title: "登录" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string; notice?: string }>
}) {
  const sp = await searchParams
  // 已持有效会话（DB 级校验通过）→ 直接进入目标页，无需重复登录
  const ctx = await getAuthContext()
  if (ctx) redirect(sp.from && sp.from.startsWith("/") && !sp.from.startsWith("//") ? sp.from : "/dashboard")
  const siteName = await getConfig<string>("ui.siteName", "Dockyard 浏览器工作平台")
  const announcement = await getConfig<string>("ui.loginAnnouncement", "")
  const allowRegister = await getConfig<boolean>("security.allowRegister", true)
  const bootstrap = await getBootstrapState()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/40 dark:via-background dark:to-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-teal-600 flex items-center justify-center text-white font-bold text-xl">D</div>
          <h1 className="text-2xl font-semibold tracking-tight">{siteName}</h1>
          <p className="text-sm text-muted-foreground">企业级远程浏览器工作平台</p>
        </div>

        {announcement && (
          <div className="rounded-lg border border-teal-200 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/40 p-3 text-sm text-teal-800 dark:text-teal-200">
            {announcement}
          </div>
        )}

        {sp.notice === "bootstrap-done" && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40 p-3 text-sm text-emerald-800 dark:text-emerald-200">
            管理员账号初始化成功，请使用新账号登录
          </div>
        )}

        {bootstrap.needsSetup && (
          <div className="rounded-lg border border-teal-200 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/40 p-3 text-sm text-teal-800 dark:text-teal-200 space-y-1">
            <p className="font-medium">系统尚未初始化</p>
            <p className="text-xs">
              检测到库中没有任何账号。<a href="/setup" className="text-teal-600 hover:underline font-medium">前往初始化管理员 →</a>
              （注册需输入服务启动生成的 Setup Token，密钥提示：<code className="mx-1 rounded bg-teal-600/10 px-1 font-mono text-[11px] font-semibold">{bootstrap.setupTokenHint}</code>，
              完整值见启动日志或 storage/setup-token.txt；或部署时配置 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量自动注册）
            </p>
          </div>
        )}

        {sp.error === "SessionRequired" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 p-3 text-sm text-amber-800 dark:text-amber-200">
            请先登录后再访问
          </div>
        )}
        {sp.error === "AccessDenied" && (
          <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/40 p-3 text-sm text-red-800 dark:text-red-200">
            访问被拒绝：权限不足
          </div>
        )}

        <Suspense fallback={<div className="h-64 rounded-xl border bg-card animate-pulse" />}>
          <LoginForm from={sp.from} allowRegister={allowRegister} />
        </Suspense>
      </div>
    </div>
  )
}
