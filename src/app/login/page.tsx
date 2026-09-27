import { Suspense } from "react"
import { getConfig } from "@/lib/config"
import { LoginForm } from "./login-form"

export const dynamic = "force-dynamic"

export const metadata = { title: "登录" }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string; notice?: string }>
}) {
  const sp = await searchParams
  const siteName = await getConfig<string>("ui.siteName", "Dockyard 浏览器工作平台")
  const announcement = await getConfig<string>("ui.loginAnnouncement", "")
  const allowRegister = await getConfig<boolean>("security.allowRegister", true)

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
