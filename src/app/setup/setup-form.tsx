"use client"

// 首启管理员注册表单（客户端校验仅体验层；服务端 registerFirstAdmin 全量强制校验）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, UserPlus, ShieldCheck, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { registerFirstAdminAction } from "@/server/actions/bootstrap"

export interface SetupFormProps {
  tokenHint?: string // 当前进程 setup token 脱敏提示（前4后4）
}

export function SetupForm({ tokenHint }: SetupFormProps) {
  const router = useRouter()
  const [form, setForm] = React.useState({ username: "", displayName: "", email: "", password: "", confirm: "", setupToken: "" })
  const [busy, setBusy] = React.useState(false)
  const [showPw, setShowPw] = React.useState(false)

  const strength = React.useMemo(() => {
    let s = 0
    const pw = form.password
    if (pw.length >= 10) s++
    if (pw.length >= 14) s++
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
    if (/[0-9]/.test(pw)) s++
    if (/[^a-zA-Z0-9]/.test(pw)) s++
    return s
  }, [form.password])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.setupToken.trim()) return toast.error("请填写启动密钥（Setup Token）")
    if (!form.username.trim()) return toast.error("请填写用户名")
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return toast.error("邮箱格式不正确")
    if (!form.password) return toast.error("请填写密码")
    if (form.password !== form.confirm) return toast.error("两次输入的密码不一致")
    setBusy(true)
    try {
      const res = await registerFirstAdminAction({
        username: form.username.trim(),
        displayName: form.displayName.trim() || null,
        email: form.email.trim() || null,
        password: form.password,
        setupToken: form.setupToken.trim(),
      })
      if (res.code === 0 && res.data?.ok) {
        toast.success(res.data.message)
        router.push("/login?notice=bootstrap-done")
      } else {
        toast.error(res.msg || (res.data?.message ?? "注册失败"))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border bg-card p-6 space-y-4 shadow-sm">
      <div className="space-y-1.5 rounded-lg border border-amber-300/60 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/30 p-3">
        <Label htmlFor="su-token" className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
          <KeyRound className="h-3.5 w-3.5" />
          启动密钥（Setup Token） *
        </Label>
        <Input
          id="su-token"
          value={form.setupToken}
          onChange={(e) => setForm({ ...form, setupToken: e.target.value })}
          placeholder="从服务启动日志或数据目录 setup-token.txt 获取"
          autoComplete="off"
          className="font-mono"
          required
        />
        <p className="text-[11px] leading-relaxed text-amber-800/80 dark:text-amber-300/80">
          服务每次启动时生成；管理员初始化完成前每次重启都会变化（当前进程密钥提示：
          <code className="font-mono font-semibold">{tokenHint || "（通道未开放）"}</code>）。
          请在服务器控制台日志或 <code className="font-mono">storage/setup-token.txt</code> 中获取完整密钥后输入。
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-username">管理员用户名 *</Label>
        <Input
          id="su-username"
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          placeholder="如 admin（3-32 位字母数字）"
          autoComplete="username"
          className="font-mono"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-display">显示名称</Label>
        <Input
          id="su-display"
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          placeholder="如 平台管理员"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-email">邮箱（可选，用于找回密码）</Label>
        <Input
          id="su-email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="admin@example.com"
          autoComplete="email"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-password">密码 *</Label>
        <div className="relative">
          <Input
            id="su-password"
            type={showPw ? "text" : "password"}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="至少 10 位，含大小写字母与数字"
            autoComplete="new-password"
            required
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowPw(!showPw)}
          >
            {showPw ? "隐藏" : "显示"}
          </button>
        </div>
        {form.password && (
          <div className="flex items-center gap-1.5 pt-0.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  strength >= i ? (strength <= 2 ? "bg-red-500" : strength <= 3 ? "bg-amber-500" : "bg-emerald-500") : "bg-muted",
                )}
              />
            ))}
            <span className="text-[10px] text-muted-foreground w-8">
              {strength <= 2 ? "弱" : strength <= 3 ? "中" : "强"}
            </span>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="su-confirm">确认密码 *</Label>
        <Input
          id="su-confirm"
          type="password"
          value={form.confirm}
          onChange={(e) => setForm({ ...form, confirm: e.target.value })}
          placeholder="再次输入密码"
          autoComplete="new-password"
          required
        />
      </div>

      <Button type="submit" className="w-full bg-teal-600 hover:bg-teal-700 font-semibold" disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
        创建超级管理员并初始化
      </Button>

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-teal-600 shrink-0 mt-0.5" />
        注册成功后本引导页将永久关闭（防重复初始化）；密钥校验、注册行为全部记入审计日志与安全事件，且全部校验由服务端强制执行。
      </p>
    </form>
  )
}
