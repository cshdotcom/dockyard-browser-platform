"use client"

// ============================================================
// r36：用户级安全隔离 + 硬件透传总控对话框（用户管理表格入口）
//
// 用户诉求：安全隔离与远程硬件透传"精确到用户"，且管理员改完用户级配置后
// 该用户的【全部沙箱】立即受控 —— 本对话框提供：
//   · 用户级网络隔离双开关（内网 / 容器安全位置，三态：继承/允许/禁止）
//   · 一键"应用到全部沙箱"：清除该用户所有沙箱级覆盖遮蔽 + 重写策略文件 +
//     重启运行中沙箱 Chromium（即时生效）
//   · 沙箱级遮蔽统计（多少沙箱自带覆盖在遮蔽用户级）+ 明细列表
//   · 硬件 17 项的沙箱级遮蔽一键清除（用户级编辑走既有硬件权限对话框）
// ============================================================

import * as React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Loader2, ShieldCheck, ShieldOff, Cpu, Layers } from "lucide-react"
import { toast } from "sonner"
import { getUserPolicyControlAction, applyUserPolicyToAllSandboxesAction, type UserPolicyControlData } from "@/server/actions/user-policy-control"

type NetTriState = "inherit" | "allow" | "deny"

function triFromVal(v: boolean | null): NetTriState {
  if (v === null) return "inherit"
  return v ? "allow" : "deny"
}
function valFromTri(t: NetTriState): boolean | null {
  return t === "inherit" ? null : t === "allow"
}

function NetToggle({ label, value, onChange, disabled }: { label: string; value: NetTriState; onChange: (v: NetTriState) => void; disabled?: boolean }) {
  const opts: Array<{ k: NetTriState; t: string; tone: string }> = [
    { k: "inherit", t: "继承组/全局", tone: "bg-muted text-muted-foreground" },
    { k: "allow", t: "允许", tone: "bg-emerald-600 text-white" },
    { k: "deny", t: "禁止", tone: "bg-rose-600 text-white" },
  ]
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex gap-1">
        {opts.map((o) => (
          <button
            key={o.k}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.k)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${value === o.k ? o.tone : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}
          >
            {o.t}
          </button>
        ))}
      </div>
    </div>
  )
}

export function UserPolicyControlDialog({
  open,
  onOpenChange,
  userId,
  username,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  userId: string
  username: string
}) {
  const [data, setData] = React.useState<UserPolicyControlData | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState<"" | "network" | "hardwareClear">("")
  const [internal, setInternal] = React.useState<NetTriState>("inherit")
  const [secure, setSecure] = React.useState<NetTriState>("inherit")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await getUserPolicyControlAction({ userId })
      if (res.code === 0 && res.data) {
        setData(res.data)
        setInternal(triFromVal(res.data.userNetwork.allowInternalNetwork))
        setSecure(triFromVal(res.data.userNetwork.allowSecureLocationAccess))
      } else toast.error(res.msg || "读取用户策略失败")
    } finally {
      setLoading(false)
    }
  }, [userId])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 应用网络隔离到全部沙箱
  const applyNetwork = async () => {
    setBusy("network")
    try {
      const res = await applyUserPolicyToAllSandboxesAction({
        userId,
        scope: "network",
        network: { allowInternalNetwork: valFromTri(internal), allowSecureLocationAccess: valFromTri(secure) },
        clearSandboxOverrides: true,
        restartRunning: true,
      })
      if (res.code === 0 && res.data) {
        toast.success(
          `已应用到该用户全部沙箱：清除沙箱级覆盖 ${res.data.clearedSandboxes} 个、策略刷新 ${res.data.policyRefreshed} 个、运行中重启 ${res.data.chromiumRestarted} 个`,
        )
        void load()
      } else toast.error(res.msg || "应用失败")
    } finally {
      setBusy("")
    }
  }

  // 清除硬件沙箱级遮蔽（用户级硬件值接管全部沙箱）
  const clearHardwareOverrides = async () => {
    setBusy("hardwareClear")
    try {
      const res = await applyUserPolicyToAllSandboxesAction({
        userId,
        scope: "hardware",
        hardwarePolicy: undefined, // 不改用户级，仅清沙箱级遮蔽
        clearSandboxOverrides: true,
        restartRunning: true,
      })
      if (res.code === 0 && res.data) {
        toast.success(`硬件权限沙箱级覆盖已清除 ${res.data.clearedSandboxes} 个，全部沙箱改跟用户级生效`)
        void load()
      } else toast.error(res.msg || "清除失败")
    } finally {
      setBusy("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-teal-600" />
            安全隔离与硬件总控 · {username}
          </DialogTitle>
          <DialogDescription>
            用户级设置 + 一键应用到该用户【全部沙箱】（清除沙箱级覆盖遮蔽、重写托管策略、重启运行中浏览器，即时生效）
          </DialogDescription>
        </DialogHeader>

        {loading && !data ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 读取策略链…
          </div>
        ) : data ? (
          <div className="space-y-4">
            {/* ---- 安全隔离（网络）---- */}
            <div className="rounded-lg border p-3 space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldOff className="h-4 w-4 text-sky-600" /> 安全隔离（内网 / 容器安全位置）
                </div>
                <Badge variant="outline" className="text-[10px]">
                  当前生效：{data.effectiveNetwork.source === "USER" ? "用户级" : data.effectiveNetwork.source === "GROUP" ? "组级" : data.effectiveNetwork.source === "SANDBOX" ? "沙箱级" : "全局默认"}
                </Badge>
              </div>
              <NetToggle label="访问内网（RFC1918 私网段）" value={internal} onChange={setInternal} disabled={!!busy} />
              <NetToggle label="访问容器内安全位置（CDP/VNC 端口、file://）" value={secure} onChange={setSecure} disabled={!!busy} />
              <div className="flex items-center gap-2 pt-2">
                <Button size="sm" disabled={!!busy} onClick={() => void applyNetwork()}>
                  {busy === "network" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
                  应用到全部沙箱（{data.sandboxTotal} 个）
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {data.sandboxNetworkOverrides > 0
                    ? `${data.sandboxNetworkOverrides} 个沙箱有沙箱级覆盖在遮蔽用户级，应用时将一并清除`
                    : "无沙箱级覆盖遮蔽（新设置直接生效）"}
                </span>
              </div>
            </div>

            {/* ---- 硬件透传 ---- */}
            <div className="rounded-lg border p-3 space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Cpu className="h-4 w-4 text-indigo-600" /> 远程硬件透传（17 项四级链）
                </div>
                <Badge variant="outline" className="text-[10px]">
                  用户级覆盖：{data.hardwarePolicy ? `${Object.keys(data.hardwarePolicy).length} 项` : "无（继承）"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                用户级硬件权限编辑走「硬件权限（17 项四级链）」菜单；此处一键让该用户
                <b>全部沙箱</b>改跟用户级（清除沙箱级 hardwareOverride 遮蔽并即时生效）。
              </p>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" disabled={!!busy || data.sandboxHardwareOverrides === 0} onClick={() => void clearHardwareOverrides()}>
                  {busy === "hardwareClear" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Layers className="mr-1 h-3.5 w-3.5" />}
                  清除沙箱级硬件遮蔽（{data.sandboxHardwareOverrides}）
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  运行中 {data.sandboxRunning} / 总 {data.sandboxTotal} 个沙箱
                </span>
              </div>
            </div>

            {/* ---- 沙箱明细 ---- */}
            {data.sandboxes.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">沙箱明细（覆盖状态）</div>
                <ScrollArea className="h-40 rounded-lg border p-2">
                  <div className="space-y-1">
                    {data.sandboxes.map((sb) => (
                      <div key={sb.id} className="flex items-center justify-between gap-2 text-xs py-0.5">
                        <span className="truncate" title={sb.name}>{sb.name}</span>
                        <span className="flex gap-1 shrink-0">
                          <Badge variant={sb.status === "RUNNING" ? "default" : "secondary"} className="text-[9px] px-1">{sb.status === "RUNNING" ? "运行中" : sb.status}</Badge>
                          {sb.netOverride && <Badge variant="outline" className="text-[9px] px-1 text-amber-600">网络覆盖</Badge>}
                          {sb.hardwareOverride && <Badge variant="outline" className="text-[9px] px-1 text-amber-600">硬件覆盖</Badge>}
                          {!sb.netOverride && !sb.hardwareOverride && <Badge variant="outline" className="text-[9px] px-1 text-emerald-600">跟用户级</Badge>}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">读取失败，请重试</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
