"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function RegisterForm({ requireActivation, siteName }: { requireActivation: boolean; siteName: string }) {
  const router = useRouter()
  const [username, setUsername] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [emailCode, setEmailCode] = React.useState("")
  const [needCode, setNeedCode] = React.useState(requireActivation)
  const [countdown, setCountdown] = React.useState(0)
  // r35：发送邮箱验证码前的人机验证
  const [captcha, setCaptcha] = React.useState<{ id: string; svg: string } | null>(null)
  const [captchaCode, setCaptchaCode] = React.useState("")
  const loadCaptcha = React.useCallback(async () => {
    const res = await fetch("/api/auth/captcha")
    const json = (await res.json()) as { data?: { captchaId: string; svg: string } }
    if (json.data) setCaptcha({ id: json.data.captchaId, svg: json.data.svg })
  }, [])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const sendCode = async () => {
    if (!email.trim() || countdown > 0) return
    setBusy(true)
    try {
      const res = await fetch("/api/auth/email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(), purpose: "REGISTER",
          captchaId: captcha?.id, captchaCode: captchaCode || undefined,
        }),
      })
      const json = (await res.json()) as { code: number; msg: string; data?: { captchaRequired?: boolean } }
      if (json.code === 41006 || json.data?.captchaRequired) {
        await loadCaptcha()
        toast.info("请先完成图形验证码后再发送邮箱验证码")
        return
      }
      if (json.code === 0) {
        toast.success(json.msg)
        setCountdown(60)
        setNeedCode(true)
        setCaptchaCode("")
      } else toast.error(json.msg)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      toast.error("两次输入的密码不一致")
      return
    }
    setBusy(true)
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          email: email.trim().toLowerCase(),
          password,
          emailCode: emailCode || undefined,
        }),
      })
      const json = (await res.json()) as { code: number; msg: string; data?: { needCode?: boolean } }
      if (json.code !== 0) {
        toast.error(json.msg)
        if (json.data?.needCode) setNeedCode(true)
        return
      }
      toast.success(json.msg)
      router.push("/login")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/40 dark:via-background dark:to-background p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold">注册账号 · {siteName}</h1>
          <p className="text-xs text-muted-foreground">{requireActivation ? "注册后需要邮箱激活方可登录" : "注册成功后即可登录使用"}</p>
        </div>

        <div className="space-y-1.5">
          <Label>用户名</Label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="字母数字组成，3-32位" autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label>邮箱地址</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </div>
        {needCode && (
          <div className="space-y-1.5">
            <Label>邮箱激活验证码</Label>
            <div className="flex gap-2">
              <Input value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6位数字" className="font-mono" />
{captcha && (
              <div className="flex items-center gap-2">
                <div className="rounded-md border overflow-hidden bg-white shrink-0" dangerouslySetInnerHTML={{ __html: captcha.svg }} onClick={() => void loadCaptcha()} title="点击刷新" />
                <input value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value)} placeholder="计算结果" className="h-9 w-24 rounded-md border bg-background px-2 text-sm" autoComplete="off" />
              </div>
            )}
                          <Button type="button" variant="secondary" disabled={countdown > 0 || !email.trim()} onClick={sendCode}>
                {countdown > 0 ? `${countdown}s` : "获取验证码"}
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>密码</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="满足密码复杂度策略" />
        </div>
        <div className="space-y-1.5">
          <Label>确认密码</Label>
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再次输入密码" />
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          注册
        </Button>
        <div className="text-center">
          <a href="/login" className="text-xs text-teal-600 underline">已有账号？返回登录</a>
        </div>
      </form>
    </div>
  )
}
