"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { signIn } from "next-auth/react"
import { toast } from "sonner"
import { Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Label } from "@/components/ui/label"

type PreLoginResp = {
  code: number
  msg: string
  data?: {
    ok?: boolean
    twoFactorRequired?: boolean
    forceSetup?: boolean
    mustChangePassword?: boolean
    ticket?: string
    captchaRequired?: boolean
    needCode?: boolean
  }
}

export function LoginForm({ from, allowRegister }: { from?: string; allowRegister: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = React.useState<"password" | "email">("password")

  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [remember, setRemember] = React.useState(false)
  const [captcha, setCaptcha] = React.useState<{ id: string; svg: string } | null>(null)
  const [captchaCode, setCaptchaCode] = React.useState("")

  const [email, setEmail] = React.useState("")
  const [emailCode, setEmailCode] = React.useState("")
  const [countdown, setCountdown] = React.useState(0)

  const [stage, setStage] = React.useState<"credentials" | "2fa" | "forced-setup">("credentials")
  const [ticket, setTicket] = React.useState("")
  const [totp, setTotp] = React.useState("")
  const [useBackup, setUseBackup] = React.useState(false)
  const [backupCode, setBackupCode] = React.useState("")
  const [trustDevice, setTrustDevice] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const loadCaptcha = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/captcha")
      const json = (await res.json()) as { data?: { captchaId: string; svg: string } }
      if (json.data) setCaptcha({ id: json.data.captchaId, svg: json.data.svg })
    } catch { /* ignore */ }
  }, [])

  // 完成登录：用 ticket 建立正式会话
  const finishLogin = React.useCallback(
    async (loginTicket: string, opts?: { totp?: string; trustDevice?: boolean }) => {
      const res = await signIn("credentials", {
        ticket: loginTicket,
        totp: opts?.totp || "",
        trustDevice: String(!!opts?.trustDevice),
        redirect: false,
      })
      if (res?.error) {
        toast.error("验证码错误或会话建立失败，请重试")
        setStage("2fa")
        setTotp("")
        return
      }
      toast.success("登录成功")
      const dest = searchParams.get("from") || from || "/dashboard"
      // push+refresh 同帧竞态会取消导航（历史 Bug：登录成功却停留登录页）；push 自带 RSC 拉取
      router.push(dest)
    },
    [router, searchParams, from]
  )

  // ---- 密码登录提交 ----
  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) return
    setBusy(true)
    try {
      const res = await fetch("/api/auth/pre-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "password",
          username: username.trim(),
          password,
          remember,
          captchaId: captcha?.id,
          captchaCode: captchaCode || undefined,
        }),
      })
      const json = (await res.json()) as PreLoginResp
      if (json.code !== 0) {
        toast.error(json.msg)
        if (json.data?.captchaRequired) {
          await loadCaptcha()
          setCaptchaCode("")
        }
        return
      }
      const d = json.data!
      if (d.twoFactorRequired && d.ticket) {
        setTicket(d.ticket)
        setStage("2fa")
        return
      }
      if (d.forceSetup && d.ticket) {
        // 强制2FA策略：先进入系统完成设置
        await finishLogin(d.ticket)
        router.push("/account/security?force2fa=1")
        return
      }
      if (d.ticket) {
        await finishLogin(d.ticket)
        if (d.mustChangePassword) {
          router.push("/account/security?mustChange=1")
        }
      }
    } catch {
      toast.error("网络异常，请重试")
    } finally {
      setBusy(false)
    }
  }

  // ---- 邮箱验证码登录 ----
  const sendEmailCode = async () => {
    if (!email.trim() || countdown > 0) return
    setBusy(true)
    try {
      const res = await fetch("/api/auth/email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), purpose: "LOGIN" }),
      })
      const json = (await res.json()) as { code: number; msg: string }
      if (json.code === 0) {
        toast.success(json.msg)
        setCountdown(60)
      } else {
        toast.error(json.msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const submitEmailCode = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || emailCode.length !== 6) return
    setBusy(true)
    try {
      const res = await fetch("/api/auth/pre-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "email", email: email.trim().toLowerCase(), code: emailCode, remember }),
      })
      const json = (await res.json()) as PreLoginResp
      if (json.code !== 0) {
        toast.error(json.msg)
        return
      }
      const d = json.data!
      if (d.twoFactorRequired && d.ticket) {
        setTicket(d.ticket)
        setStage("2fa")
        return
      }
      if (d.forceSetup && d.ticket) {
        await finishLogin(d.ticket)
        router.push("/account/security?force2fa=1")
        return
      }
      if (d.ticket) await finishLogin(d.ticket)
    } catch {
      toast.error("网络异常，请重试")
    } finally {
      setBusy(false)
    }
  }

  // ---- 2FA 提交 ----
  const submit2fa = async (e: React.FormEvent) => {
    e.preventDefault()
    const code = useBackup ? backupCode.trim() : totp
    if (!code) return
    setBusy(true)
    try {
      await finishLogin(ticket, { totp: code, trustDevice })
    } finally {
      setBusy(false)
    }
  }

  // ================= 2FA 阶段 =================
  if (stage === "2fa") {
    return (
      <form onSubmit={submit2fa} className="rounded-xl border bg-card p-6 space-y-5 shadow-sm">
        <div className="space-y-1 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-teal-600" />
          <h2 className="text-lg font-semibold">双因素验证</h2>
          <p className="text-sm text-muted-foreground">请输入验证器App中的6位动态码</p>
        </div>

        {!useBackup ? (
          <div className="flex flex-col items-center gap-2">
            <InputOTP maxLength={6} value={totp} onChange={setTotp}>
              <InputOTPGroup>
                {Array.from({ length: 6 }).map((_, i) => (
                  <InputOTPSlot key={i} index={i} />
                ))}
              </InputOTPGroup>
            </InputOTP>
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setUseBackup(true)}>
              使用一次性备份码登录
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>一次性备份恢复码</Label>
            <Input
              placeholder="XXXX-XXXX"
              value={backupCode}
              onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
              className="font-mono"
              autoFocus
            />
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setUseBackup(false)}>
              返回动态码验证
            </button>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox id="trust" checked={trustDevice} onCheckedChange={(v) => setTrustDevice(!!v)} />
          <Label htmlFor="trust" className="text-sm font-normal text-muted-foreground">
            信任此设备（{30}天内免二次验证）
          </Label>
        </div>

        <Button type="submit" className="w-full" disabled={busy || (!useBackup && totp.length !== 6)}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          验证并登录
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setStage("credentials")
            setTotp("")
            setBackupCode("")
          }}
          disabled={busy}
        >
          返回重新登录
        </Button>
      </form>
    )
  }

  // ================= 凭证阶段 =================
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm space-y-5">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "password" | "email")}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="password">密码登录</TabsTrigger>
          <TabsTrigger value="email">邮箱验证码登录</TabsTrigger>
        </TabsList>

        <TabsContent value="password" className="mt-4">
          <form onSubmit={submitPassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">账号 / 邮箱</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名或邮箱地址" autoComplete="username" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            </div>
            {captcha && (
              <div className="space-y-1.5">
                <Label htmlFor="cap">图形验证码</Label>
                <div className="flex gap-2 items-center">
                  <div className="rounded-md border overflow-hidden bg-white" dangerouslySetInnerHTML={{ __html: captcha.svg }} />
                  <Input id="cap" value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value)} placeholder="计算结果" className="w-28" autoComplete="off" />
                  <Button type="button" variant="ghost" size="sm" onClick={loadCaptcha}>
                    刷新
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
                <Label htmlFor="remember" className="text-sm font-normal text-muted-foreground">
                  记住我
                </Label>
              </div>
              <a href="/forgot-password" className="text-xs text-muted-foreground underline">
                忘记密码？
              </a>
            </div>
            <Button type="submit" className="w-full" disabled={busy || !username.trim() || !password}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              登 录
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="email" className="mt-4">
          <form onSubmit={submitEmailCode} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">邮箱地址</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>验证码</Label>
              <div className="flex gap-2">
                <Input value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6位数字" className="font-mono tracking-widest" />
                <Button type="button" variant="secondary" disabled={countdown > 0 || !email.trim()} onClick={sendEmailCode} className="whitespace-nowrap">
                  {countdown > 0 ? `${countdown}s` : "获取验证码"}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="remember2" checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
              <Label htmlFor="remember2" className="text-sm font-normal text-muted-foreground">
                记住我（延长会话有效期）
              </Label>
            </div>
            <Button type="submit" className="w-full" disabled={busy || emailCode.length !== 6}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              验证并登录
            </Button>
          </form>
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between text-xs">
        {allowRegister ? (
          <a href="/register" className="text-teal-600 hover:underline">
            没有账号？注册新账号
          </a>
        ) : (
          <span className="text-muted-foreground">注册通道已关闭</span>
        )}
        <span className="text-muted-foreground">登录即代表同意平台安全策略</span>
      </div>
    </div>
  )
}
