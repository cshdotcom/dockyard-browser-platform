"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// 找回密码：全部通过邮箱链路完成身份确认，接口不返回账号状态
export function ForgotPasswordForm() {
  const router = useRouter()
  const [email, setEmail] = React.useState("")
  const [code, setCode] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [countdown, setCountdown] = React.useState(0)
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
        body: JSON.stringify({ email: email.trim().toLowerCase(), purpose: "RESET_PASSWORD" }),
      })
      const json = (await res.json()) as { code: number; msg: string }
      if (json.code === 0) {
        toast.success(json.msg)
        setCountdown(60)
      } else toast.error(json.msg)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code, newPassword }),
      })
      const json = (await res.json()) as { code: number; msg: string }
      if (json.code === 0) {
        toast.success(json.msg)
        router.push("/login")
      } else toast.error(json.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-teal-50 via-white to-white dark:from-teal-950/40 dark:via-background dark:to-background p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold">找回密码</h1>
          <p className="text-xs text-muted-foreground">通过注册邮箱验证码确认身份并重置密码</p>
        </div>
        <div className="space-y-1.5">
          <Label>注册邮箱</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label>邮箱验证码</Label>
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6位数字" className="font-mono" />
            <Button type="button" variant="secondary" disabled={countdown > 0 || !email.trim()} onClick={sendCode}>
              {countdown > 0 ? `${countdown}s` : "获取验证码"}
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>新密码</Label>
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="满足密码复杂度策略" />
        </div>
        <Button type="submit" className="w-full" disabled={busy || code.length !== 6 || !newPassword}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          重置密码
        </Button>
        <div className="text-center">
          <a href="/login" className="text-xs text-teal-600 underline">返回登录</a>
        </div>
      </form>
    </div>
  )
}
