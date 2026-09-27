"use client"

import * as React from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { ShieldCheck, KeyRound, Mail, ScrollText, MonitorSmartphone, Loader2, Copy, ShieldAlert, CheckCircle2 } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  start2faSetupAction, confirm2faSetupAction, disable2faAction, regenerateBackupCodesAction,
  changePasswordAction, sendEmailChangeCodeAction, changeEmailAction, getBackupCodeCountAction,
} from "@/server/actions/account"
import { ConfirmDialog } from "@/components/shared/confirm"
import { cn } from "@/lib/utils"

export interface SecurityTabData {
  username: string
  email: string | null
  emailVerified: boolean
  twoFactorEnabled: boolean
  backupCodeCount: number
  trustedDevices: { id: string; label: string; ua: string; ip: string; lastUsed: string; expiresAt: string }[]
  events: { id: string; eventType: string; success: boolean; detail: string; ip: string; createdAt: string }[]
  hasPassword: boolean
}

export function SecurityTabs({ data, force2fa }: { data: SecurityTabData; force2fa: boolean }) {
  const [tab, setTab] = React.useState<string>(force2fa ? "2fa" : "2fa")
  return (
    <Tabs value={tab} onValueChange={setTab} defaultValue="2fa">
      <TabsList className="grid w-full grid-cols-2 md:grid-cols-5 h-auto">
        <TabsTrigger value="2fa" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />双因素认证</TabsTrigger>
        <TabsTrigger value="password" className="gap-1.5"><KeyRound className="h-3.5 w-3.5" />修改密码</TabsTrigger>
        <TabsTrigger value="email" className="gap-1.5"><Mail className="h-3.5 w-3.5" />邮箱绑定</TabsTrigger>
        <TabsTrigger value="devices" className="gap-1.5"><MonitorSmartphone className="h-3.5 w-3.5" />受信设备</TabsTrigger>
        <TabsTrigger value="logs" className="gap-1.5"><ScrollText className="h-3.5 w-3.5" />安全日志</TabsTrigger>
      </TabsList>

      <TabsContent value="2fa" className="mt-4"><TwoFactorPanel data={data} force={force2fa} /></TabsContent>
      <TabsContent value="password" className="mt-4"><ChangePasswordPanel has2fa={data.twoFactorEnabled} /></TabsContent>
      <TabsContent value="email" className="mt-4"><ChangeEmailPanel email={data.email} verified={data.emailVerified} /></TabsContent>
      <TabsContent value="devices" className="mt-4"><TrustedDevicesPanel devices={data.trustedDevices} /></TabsContent>
      <TabsContent value="logs" className="mt-4"><SecurityLogsPanel events={data.events} /></TabsContent>
    </Tabs>
  )
}

// ================= 2FA 面板 =================
function TwoFactorPanel({ data, force }: { data: SecurityTabData; force: boolean }) {
  const router = useRouter()
  const [enabled, setEnabled] = React.useState(data.twoFactorEnabled)
  const [backupCount, setBackupCount] = React.useState(data.backupCodeCount)

  // 开启流程状态
  const [setupData, setSetupData] = React.useState<{ secret: string; qrDataUrl: string; otpauthUrl: string } | null>(null)
  const [verifyCode, setVerifyCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [backupCodes, setBackupCodes] = React.useState<string[] | null>(null)
  const [showBackupDialog, setShowBackupDialog] = React.useState(false)
  const [disableCode, setDisableCode] = React.useState("")
  const [showDisable, setShowDisable] = React.useState(false)
  const [regenCode, setRegenCode] = React.useState("")
  const [showRegen, setShowRegen] = React.useState(false)

  const startSetup = async () => {
    setBusy(true)
    try {
      const res = await start2faSetupAction()
      if (res.code === 0 && res.data && (res.data as { secret?: string }).secret) {
        setSetupData(res.data as { secret: string; qrDataUrl: string; otpauthUrl: string })
        setVerifyCode("")
      } else {
        toast.error(res.msg || "无法开始设置")
      }
    } finally {
      setBusy(false)
    }
  }

  const confirmSetup = async () => {
    if (verifyCode.length !== 6) return
    setBusy(true)
    try {
      const res = await confirm2faSetupAction({ code: verifyCode })
      if (res.code === 0) {
        setEnabled(true)
        setBackupCodes(res.data?.backupCodes ?? [])
        setShowBackupDialog(true)
        setSetupData(null)
        setBackupCount(await fetchBackupCount())
        toast.success("双因素认证已开启")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const fetchBackupCount = async () => {
    const res = await getBackupCodeCountAction()
    return res.data?.count ?? 0
  }

  const doDisable = async () => {
    setBusy(true)
    try {
      const res = await disable2faAction({ code: disableCode })
      if (res.code === 0) {
        setEnabled(false)
        setShowDisable(false)
        setDisableCode("")
        setBackupCount(0)
        toast.success("双因素认证已关闭")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  const doRegen = async () => {
    setBusy(true)
    try {
      const res = await regenerateBackupCodesAction({ code: regenCode })
      if (res.code === 0) {
        setBackupCodes(res.data?.backupCodes ?? [])
        setShowRegen(false)
        setShowBackupDialog(true)
        setBackupCount(await fetchBackupCount())
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> TOTP 双因素认证
              {enabled ? (
                <Badge className="bg-emerald-600 hover:bg-emerald-600">已开启</Badge>
              ) : (
                <Badge variant="outline">未开启</Badge>
              )}
            </span>
            {enabled ? (
              <Button variant="outline" size="sm" onClick={() => setShowDisable(true)}>
                关闭 2FA
              </Button>
            ) : (
              <Button size="sm" onClick={startSetup} disabled={busy}>
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {setupData ? "重新生成密钥" : "开启 2FA"}
              </Button>
            )}
          </CardTitle>
          <CardDescription>
            使用 Google Authenticator / Microsoft Authenticator 等验证器App扫描二维码，登录时需输入6位动态码。
            {force && <span className="text-amber-600 dark:text-amber-400"> 当前账号被管理员强制要求开启2FA。</span>}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {enabled && (
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                剩余一次性备份码：<span className="font-semibold tabular-nums">{backupCount}</span> 组
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowRegen(true)}>
                重置备份码
              </Button>
            </div>
          )}

          {!enabled && setupData && (
            <div className="grid md:grid-cols-2 gap-6 rounded-lg border p-4">
              <div className="flex flex-col items-center justify-center gap-3">
                
                <img src={setupData.qrDataUrl} alt="TOTP 二维码" className="rounded-lg border p-2 bg-white" width={220} height={220} />
                <p className="text-xs text-muted-foreground">扫描二维码添加验证器</p>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>手动输入密钥（无法扫码时）</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={setupData.secret} className="font-mono text-xs" />
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={() => {
                        void navigator.clipboard.writeText(setupData.secret)
                        toast.success("密钥已复制")
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>输入 App 上的 6 位动态码完成校验</Label>
                  <InputOTP maxLength={6} value={verifyCode} onChange={setVerifyCode}>
                    <InputOTPGroup>
                      {Array.from({ length: 6 }).map((_, i) => (
                        <InputOTPSlot key={i} index={i} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                <Button className="w-full" onClick={confirmSetup} disabled={busy || verifyCode.length !== 6}>
                  {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                  校验并正式开启
                </Button>
              </div>
            </div>
          )}

          {!enabled && !setupData && (
            <div className="text-sm text-muted-foreground rounded-lg border border-dashed p-6 text-center">
              <ShieldCheck className="mx-auto h-8 w-8 opacity-30 mb-2" />
              尚未开启双因素认证。开启后登录需输入动态验证码，即使密码泄露也能保护账号安全。
            </div>
          )}
        </CardContent>
      </Card>

      {/* 备份码展示弹窗（一次性） */}
      <Dialog open={showBackupDialog} onOpenChange={(v) => { if (!v) setBackupCodes(null); setShowBackupDialog(v) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" /> 一次性备份恢复码
            </DialogTitle>
            <DialogDescription>
              每组备份码只能使用一次。请立即保存（截图或抄写），丢失后只能通过重置恢复。此页面关闭后将无法再次查看。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {backupCodes?.map((c) => (
              <div key={c} className="rounded-md border bg-muted/50 px-3 py-2 text-center tracking-wider">{c}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                void navigator.clipboard.writeText((backupCodes || []).join("\n"))
                toast.success("全部备份码已复制")
              }}
            >
              <Copy className="mr-1 h-4 w-4" /> 复制全部
            </Button>
            <Button className="flex-1" onClick={() => { setBackupCodes(null); setShowBackupDialog(false) }}>
              我已妥善保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 关闭2FA确认 */}
      <Dialog open={showDisable} onOpenChange={setShowDisable}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-red-500" /> 关闭双因素认证</DialogTitle>
            <DialogDescription>为保护账号安全，关闭前必须验证当前 TOTP 动态码或有效备份码。</DialogDescription>
          </DialogHeader>
          <Input placeholder="6位动态码 / 备份码 XXXX-XXXX" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} autoFocus />
          <Button variant="destructive" onClick={doDisable} disabled={busy || disableCode.length < 4}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 验证并关闭
          </Button>
        </DialogContent>
      </Dialog>

      {/* 重置备份码确认 */}
      <Dialog open={showRegen} onOpenChange={setShowRegen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重置备份码</DialogTitle>
            <DialogDescription>输入动态码验证身份，重置后旧备份码全部作废。</DialogDescription>
          </DialogHeader>
          <Input placeholder="6位动态码 / 备份码" value={regenCode} onChange={(e) => setRegenCode(e.target.value)} autoFocus />
          <Button onClick={doRegen} disabled={busy || regenCode.length < 4}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 验证并重置
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ================= 修改密码 =================
function ChangePasswordPanel({ has2fa }: { has2fa: boolean }) {
  const router = useRouter()
  const [oldPassword, setOld] = React.useState("")
  const [newPassword, setNew] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [totp, setTotp] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    try {
      const res = await changePasswordAction({ oldPassword, newPassword, confirmPassword: confirm, totpCode: totp })
      if (res.code === 0) {
        toast.success("密码修改成功，其它设备已全部下线")
        setResult(`修改成功${typeof (res.data as { kickedSessions?: number })?.kickedSessions === "number" ? `，已踢除 ${(res.data as { kickedSessions: number }).kickedSessions} 个其它登录会话` : ""}`)
        setOld(""); setNew(""); setConfirm(""); setTotp("")
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">修改密码</CardTitle>
        <CardDescription>
          需校验旧密码；{has2fa ? "已开启双因素认证，还需输入TOTP动态码。" : "开启2FA后将额外要求动态码校验。"}
          修改成功后自动踢除除当前设备外的全部登录会话。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-sm">
          <div className="space-y-1.5">
            <Label>旧密码</Label>
            <Input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-1.5">
            <Label>新密码</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" />
            <p className="text-[11px] text-muted-foreground">需满足平台密码复杂度策略，且不能与最近使用过的密码重复</p>
          </div>
          <div className="space-y-1.5">
            <Label>确认新密码</Label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </div>
          {has2fa && (
            <div className="space-y-1.5">
              <Label>TOTP 动态码（双因素校验）</Label>
              <Input value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6位数字" className="font-mono tracking-widest" />
            </div>
          )}
          <Button type="submit" disabled={busy || !oldPassword || !newPassword || newPassword !== confirm}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 确认修改
          </Button>
          {result && <p className="text-sm text-emerald-600">{result}</p>}
        </form>
      </CardContent>
    </Card>
  )
}

// ================= 换绑邮箱 =================
function ChangeEmailPanel({ email, verified }: { email: string | null; verified: boolean }) {
  const router = useRouter()
  const [newEmail, setNewEmail] = React.useState("")
  const [oldCode, setOldCode] = React.useState("")
  const [newCode, setNewCode] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [countdown, setCountdown] = React.useState<{ old: number; new: number }>({ old: 0, new: 0 })

  React.useEffect(() => {
    if (countdown.old <= 0 && countdown.new <= 0) return
    const t = setTimeout(() => setCountdown((c) => ({ old: Math.max(0, c.old - 1), new: Math.max(0, c.new - 1) })), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  const sendCode = async (which: "old" | "new") => {
    if (which === "new" && !newEmail.trim()) {
      toast.error("请先输入新邮箱地址")
      return
    }
    setBusy(true)
    try {
      const res = await sendEmailChangeCodeAction({ which, newEmail: which === "new" ? newEmail.trim().toLowerCase() : undefined })
      if (res.code === 0) {
        toast.success(`验证码已发送至 ${res.data?.to ?? ""}`)
        setCountdown((c) => ({ ...c, [which]: 60 }))
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await changeEmailAction({ oldCode, newCode, newEmail: newEmail.trim().toLowerCase(), password })
      if (res.code === 0) {
        toast.success("绑定邮箱已变更")
        setOldCode(""); setNewCode(""); setPassword("")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">换绑邮箱</CardTitle>
        <CardDescription>
          当前邮箱：{email ? <span className="font-mono">{email}</span> : "未绑定"}{" "}
          {email && (verified ? <Badge className="bg-emerald-600 hover:bg-emerald-600 ml-1">已验证</Badge> : <Badge variant="outline" className="ml-1">未验证</Badge>)}
          <br />需要向旧邮箱与新邮箱分别发送验证码，双重校验通过后才能更换绑定（全程记录审计日志）。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-md">
          <div className="space-y-1.5">
            <Label>登录密码（身份确认）</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {email && (
            <div className="space-y-1.5">
              <Label>旧邮箱验证码（{email}）</Label>
              <div className="flex gap-2">
                <Input value={oldCode} onChange={(e) => setOldCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="font-mono" placeholder="6位数字" />
                <Button type="button" variant="secondary" disabled={countdown.old > 0 || busy} onClick={() => sendCode("old")}>
                  {countdown.old > 0 ? `${countdown.old}s` : "发送"}
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>新邮箱地址</Label>
            <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="new@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>新邮箱验证码</Label>
            <div className="flex gap-2">
              <Input value={newCode} onChange={(e) => setNewCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="font-mono" placeholder="6位数字" />
              <Button type="button" variant="secondary" disabled={countdown.new > 0 || busy || !newEmail.trim()} onClick={() => sendCode("new")}>
                {countdown.new > 0 ? `${countdown.new}s` : "发送"}
              </Button>
            </div>
          </div>
          <Button type="submit" disabled={busy || !password || (email ? oldCode.length !== 6 : false) || !newEmail.trim() || newCode.length !== 6}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} 双重验证并换绑
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

// ================= 受信任设备 =================
function TrustedDevicesPanel({ devices }: { devices: SecurityTabData["trustedDevices"] }) {
  const router = useRouter()
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const revoke = async (id: string) => {
    setBusyId(id)
    try {
      const { revokeMyTrustedDeviceAction } = await import("@/server/actions/profile")
      const res = await revokeMyTrustedDeviceAction({ deviceId: id })
      if (res.code === 0) {
        toast.success("已撤销该受信任设备")
        router.refresh()
      } else toast.error(res.msg)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">受信任设备</CardTitle>
        <CardDescription>登录时勾选「信任此设备」的设备列表，这些设备在有效期内登录可跳过2FA二次验证。可手动撤销任意设备。</CardDescription>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8 rounded-lg border border-dashed">暂无受信任设备</p>
        ) : (
          <div className="space-y-2">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{d.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{d.ua}</p>
                  <p className="text-xs text-muted-foreground">IP {d.ip} · 最后使用 {d.lastUsed} · 有效期至 {d.expiresAt}</p>
                </div>
                <Button variant="outline" size="sm" disabled={busyId === d.id} onClick={() => revoke(d.id)}>
                  {busyId === d.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  撤销信任
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ================= 安全日志 =================
const EVENT_LABELS: Record<string, string> = {
  LOGIN_SUCCESS: "登录成功", LOGIN_FAILED: "登录失败", LOGIN_PASSWORD: "密码登录", LOGIN_EMAIL_CODE: "邮箱验证码登录",
  LOGIN_2FA: "2FA验证", LOGIN_BLOCKED: "登录被拦截", ACCOUNT_LOCKED: "账号锁定", REMOTE_LOGIN_ALERT: "异地登录提醒",
  LOGOUT: "退出登录", PASSWORD_CHANGE: "修改密码", PASSWORD_RESET: "重置密码", EMAIL_CHANGE: "换绑邮箱",
  TWOFA_ENABLED: "开启2FA", TWOFA_DISABLED: "关闭2FA", TWOFA_DISABLE_FAILED: "关闭2FA失败",
  DEVICE_REVOKED: "设备下线", DEVICE_KICKED: "管理员强制下线", EMAIL_CODE_SENT: "验证码发送", REGISTER: "注册",
}

function SecurityLogsPanel({ events }: { events: SecurityTabData["events"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">安全日志</CardTitle>
        <CardDescription>您账号的全部安全事件：登录、密码修改、2FA 开关、邮箱变更、设备下线等</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-96 overflow-y-auto rounded-lg border divide-y">
          {events.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无安全事件</p>}
          {events.map((e) => (
            <div key={e.id} className="flex items-start justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm">
                  <span className={cn("inline-block h-2 w-2 rounded-full mr-2", e.success ? "bg-emerald-500" : "bg-red-500")} />
                  {EVENT_LABELS[e.eventType] || e.eventType}
                  {e.detail && <span className="ml-2 text-muted-foreground text-xs">{e.detail}</span>}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">IP {e.ip} · {e.createdAt}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
