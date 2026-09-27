import { getConfig, getConfigBool } from "@/lib/config"
import { RegisterForm } from "./register-form"

export const dynamic = "force-dynamic"

export const metadata = { title: "注册 - Dockyard" }

export default async function RegisterPage() {
  const allowRegister = await getConfigBool("security.allowRegister", true)
  const requireActivation = await getConfigBool("security.requireEmailActivation", false)
  const siteName = await getConfig<string>("ui.siteName", "Dockyard")
  if (!allowRegister) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="rounded-xl border bg-card p-8 text-center max-w-md space-y-3">
          <h1 className="text-xl font-semibold">注册通道已关闭</h1>
          <p className="text-sm text-muted-foreground">管理员已关闭自主注册，请联系系统管理员开通账号。</p>
          <a href="/login" className="text-teal-600 underline text-sm">返回登录</a>
        </div>
      </div>
    )
  }
  return <RegisterForm requireActivation={requireActivation} siteName={siteName} />
}
