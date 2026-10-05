"use client"

// r37：访客访问客户端面板
//   · invalid / login-required / guest 三态
//   · 密码门控 → 公共 API 取票（VNC / CDP）
//   · VNC：复用 HelmPortViewer（fetchTicket 注入访客票据供给器）
//   · CDP：取票面板（外网地址 + 复制 + 单次/时效提示）

import * as React from "react"
import { Eye, KeyRound, Link2, Loader2, Lock, Monitor, Terminal, XCircle, Globe, Copy, CheckCircle2, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { HelmPortViewer, type HelmPortTicketData } from "@/components/vnc/helmport-viewer"

export interface GuestViewState {
  kind: "invalid" | "login-required" | "guest"
  msg?: string
  redeemUrl?: string
  token?: string
  hasPassword?: boolean
  workspace?: {
    id: string; uuid: string; name: string; status: string
    mode: string; novncSessionId: string | null
    crashCategory?: string | null; freezeReason?: string | null
    ownerName: string; mySharePermission: string | null; isOwner: boolean; isAdmin: boolean
  }
  permission?: string
  guestCdp?: boolean
  readonly?: boolean
  guestMaxSessionMinutes?: number
}

export function GuestViewPanel({ state }: { state: GuestViewState }) {
  const [password, setPassword] = React.useState("")
  const [pwVerified, setPwVerified] = React.useState(false)
  const [pwChecking, setPwChecking] = React.useState(false)
  const [pwError, setPwError] = React.useState("")

  const ws = state.workspace

  // 访客 VNC 票据供给器（注入 HelmPortViewer；依赖 token+password）
  const fetchGuestTicket = React.useCallback(async (): Promise<HelmPortTicketData | null> => {
    if (!state.token) return null
    try {
      const res = await fetch("/api/guest/vnc-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, password: password || undefined }),
      })
      const j = (await res.json()) as { code?: number; msg?: string; data?: HelmPortTicketData }
      if (res.status !== 200 || j.code !== 0 || !j.data) {
        throw new Error(j.msg || "取票失败")
      }
      return j.data
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "取票失败")
    }
  }, [state.token, password])

  const verifyPassword = React.useCallback(async () => {
    if (!state.token) return
    setPwChecking(true)
    setPwError("")
    try {
      // r37：独立密码校验端点（CDP 轻量模式沙箱同样可通过密码门；原复用 vnc-ticket → CDP 模式恒 403）
      const res = await fetch("/api/guest/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: state.token, password }),
      })
      const j = (await res.json()) as { code?: number; msg?: string }
      if (res.status === 200 && j.code === 0) {
        setPwVerified(true)
      } else {
        setPwError(j.msg || "访问密码不正确")
      }
    } catch {
      setPwError("校验失败，请稍后重试")
    } finally {
      setPwChecking(false)
    }
  }, [state.token, password])

  // ---- 无效/受限态（-hooks 之后早退） ----
  if (state.kind !== "guest" || !ws) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              {state.kind === "login-required" ? <Lock className="h-5 w-5 text-amber-500" /> : <XCircle className="h-5 w-5 text-red-600" />}
              {state.kind === "login-required" ? "需要登录" : "链接无法使用"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-800 p-3">
              <ShieldAlert className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">{state.msg}</p>
            </div>
            {state.redeemUrl && (
              <Button className="w-full bg-teal-600 hover:bg-teal-700" onClick={() => { window.location.href = state.redeemUrl! }}>
                <Globe className="mr-1 h-4 w-4" /> 登录并兑换共享
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // ---- 密码门控（未验证时先输密码；密码经公共 API 校验后才发票） ----
  const needPw = !!state.hasPassword && !pwVerified

  const vncReady = ws.mode === "novnc_full" && (ws.status === "RUNNING" || ws.status === "IDLE") && ws.novncSessionId

  return (
    <div className="min-h-screen bg-background">
      {/* 顶部品牌条（访客无导航） */}
      <div className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Monitor className="h-4 w-4 text-teal-600 shrink-0" />
            <span className="text-sm font-semibold truncate">Dockyard 访客接入</span>
            <Badge variant={state.readonly ? "outline" : "secondary"} className="shrink-0">
              {state.readonly ? <><Eye className="mr-1 h-3 w-3" />只读观看</> : <><KeyRound className="mr-1 h-3 w-3" />可操作</>}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground truncate">工作区：{ws.name}</span>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {needPw ? (
          <Card className="max-w-md mx-auto">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> 访问密码</CardTitle>
              <CardDescription>该分享链接受密码保护，请输入密码后接入</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="guest-pw">密码</Label>
                <Input
                  id="guest-pw" type="password" value={password} autoComplete="off"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && password) void verifyPassword() }}
                  placeholder="输入链接访问密码"
                />
              </div>
              {pwError && <p className="text-xs text-red-600">{pwError}</p>}
              <Button className="w-full bg-teal-600 hover:bg-teal-700" disabled={pwChecking || !password} onClick={() => void verifyPassword()}>
                {pwChecking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <KeyRound className="mr-1 h-4 w-4" />}
                验证并接入
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* VNC 访客观看/操作 */}
            {ws.mode === "novnc_full" && (
              vncReady ? (
                <HelmPortViewer
                  workspace={{ ...ws }}
                  fetchTicket={async () => fetchGuestTicket()}
                  allowVncAudio={false}
                  allowWebKiosk={false}
                />
              ) : (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    远程桌面会话未运行（状态：{ws.status}）。请稍后刷新，或联系分享者启动工作区。
                  </CardContent>
                </Card>
              )
            )}

            {/* CDP 轻量模式（无远程桌面画面） */}
            {ws.mode !== "novnc_full" && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2"><Terminal className="h-4 w-4" /> CDP 轻量工作区</CardTitle>
                  <CardDescription>该工作区以 CDP 模式运行（无远程桌面画面）{state.guestCdp ? "，你可以获取外网 CDP 连接地址用于自动化工具接入" : "，未开放访客 CDP 接入"}</CardDescription>
                </CardHeader>
                {state.guestCdp && <GuestCdpPanel token={state.token!} password={password || undefined} />}
              </Card>
            )}

            {/* 访客 CDP（VNC 模式下也可附赠 CDP 接入） */}
            {ws.mode === "novnc_full" && state.guestCdp && (
              <GuestCdpPanel token={state.token!} password={password || undefined} />
            )}

            {/* 说明卡 */}
            <Card>
              <CardContent className="py-3 text-xs text-muted-foreground space-y-1">
                <p>· 访客会话时长上限：{state.guestMaxSessionMinutes ? `${state.guestMaxSessionMinutes} 分钟` : "不限"}（管理员配置）</p>
                <p>· 所有访客访问均被平台审计（含来源 IP 与时间）；敏感操作请勿在共享桌面进行</p>
                {!state.readonly && <p>· 你拥有键盘/鼠标操作权（读写级）；操作即代表接受分享者的授权边界</p>}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

// ---- 访客 CDP 取票面板 ----
function GuestCdpPanel({ token, password }: { token: string; password?: string }) {
  const [loading, setLoading] = React.useState(false)
  const [addr, setAddr] = React.useState<string | null>(null)
  const [note, setNote] = React.useState("")
  const [err, setErr] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  const fetchCdp = async () => {
    setLoading(true)
    setErr("")
    try {
      const res = await fetch("/api/guest/cdp-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const j = (await res.json()) as { code?: number; msg?: string; data?: { gatewayUrl: string; windowSec: number; note: string } }
      if (res.status !== 200 || j.code !== 0 || !j.data) throw new Error(j.msg || "取票失败")
      setAddr(j.data.gatewayUrl)
      setNote(j.data.note)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "取票失败")
    } finally {
      setLoading(false)
    }
  }

  return (
    <CardContent className="space-y-3 pt-0">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void fetchCdp()} disabled={loading}>
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Link2 className="mr-1 h-4 w-4" />}
          获取外网 CDP 连接地址（票据）
        </Button>
        {addr && (
          <Button size="sm" variant="ghost" onClick={async () => {
            try { await navigator.clipboard.writeText(addr) } catch { /* noop */ }
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}>
            {copied ? <CheckCircle2 className="mr-1 h-4 w-4 text-teal-600" /> : <Copy className="mr-1 h-4 w-4" />}
            复制地址
          </Button>
        )}
      </div>
      {addr && (
        <div className="rounded-md border bg-muted/40 p-2.5 space-y-1">
          <p className="text-xs font-mono break-all select-all">{addr}</p>
          <p className="text-[11px] text-muted-foreground">{note}</p>
        </div>
      )}
      {err && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/70 dark:bg-red-950/30 dark:border-red-800 p-2.5">
          <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <p className="text-xs text-muted-foreground">{err}</p>
        </div>
      )}
    </CardContent>
  )
}
