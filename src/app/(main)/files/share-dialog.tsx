"use client"

// ============================================================
// 创建分享对话框（r28a 用户云盘核心功能）
//   · 多选文件批量分享（fileIds 精确白名单形态）
//   · 权限 VIEW（仅预览）/ DOWNLOAD（可下载）
//   · 访客密钥（可开关 + 随机 8 位生成按钮；哈希入库、明文仅本次展示）
//   · 有效期：快捷 chips（30分钟/1小时/1天/7天/永久）+ 自定义分钟数
//   · 最大访问次数（0 = 不限）
//   · 创建成功 → 一次性展示 URL + 密钥（复制按钮 + 「打开验证」链接）
//     说明 token 为 32 字节随机 hex（128bit 不可枚举）
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { PrecisionInput } from "@/components/shared/confirm"
import { Copy, ExternalLink, Loader2, RefreshCw, ShieldCheck, CheckCircle2 } from "lucide-react"
import { createFileShareAction } from "@/server/actions/files"
import type { UserFileRow } from "./types"

type ExpireMode = "30m" | "1h" | "1d" | "7d" | "forever" | "custom"

const EXPIRE_CHIPS: Array<{ key: ExpireMode; label: string; minutes: number }> = [
  { key: "30m", label: "30 分钟", minutes: 30 },
  { key: "1h", label: "1 小时", minutes: 60 },
  { key: "1d", label: "1 天", minutes: 1440 },
  { key: "7d", label: "7 天", minutes: 10080 },
]

// 无歧义随机密钥字符集（去 0/O/1/I/l）
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

function randomKey(len = 8): string {
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  let out = ""
  for (let i = 0; i < len; i++) out += KEY_ALPHABET[buf[i] % KEY_ALPHABET.length]
  return out
}

interface ShareResultView {
  url: string
  token: string
  visitorKeyPlain: string | null
  fileCount: number
  totalBytes: number
  expireAt: string | null
}

interface ShareDialogProps {
  rows: UserFileRow[]
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 创建成功回调（刷新「我的分享」面板） */
  onCreated: () => void
}

export function ShareDialog({ rows, open, onOpenChange, onCreated }: ShareDialogProps) {
  const [name, setName] = React.useState("")
  const [permission, setPermission] = React.useState<"VIEW" | "DOWNLOAD">("VIEW")
  const [keyEnabled, setKeyEnabled] = React.useState(false)
  const [keyText, setKeyText] = React.useState("")
  const [expireMode, setExpireMode] = React.useState<ExpireMode>("7d")
  const [customMinutes, setCustomMinutes] = React.useState(60)
  const [maxUses, setMaxUses] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)
  const [result, setResult] = React.useState<ShareResultView | null>(null)

  // 打开时重置（保留默认值）
  React.useEffect(() => {
    if (open) {
      setName("")
      setPermission("VIEW")
      setKeyEnabled(false)
      setKeyText("")
      setExpireMode("7d")
      setCustomMinutes(60)
      setMaxUses(0)
      setResult(null)
    }
  }, [open])

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label}已复制到剪贴板`)
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  const submit = async () => {
    if (rows.length === 0) {
      toast.error("请先选择要分享的文件")
      return
    }
    if (keyEnabled && keyText.trim().length < 4) {
      toast.error("访客密钥至少 4 个字符（建议用随机生成）")
      return
    }
    if (expireMode === "custom" && (!Number.isFinite(customMinutes) || customMinutes < 1)) {
      toast.error("自定义有效期至少 1 分钟（0 或留空请选「永久」）")
      return
    }
    const expireMinutes =
      expireMode === "forever" ? 0 : expireMode === "custom" ? Math.floor(customMinutes) : EXPIRE_CHIPS.find((c) => c.key === expireMode)!.minutes

    setSubmitting(true)
    try {
      const res = await createFileShareAction({
        fileIds: rows.map((r) => r.id),
        name: name.trim() || undefined,
        permission,
        visitorKey: keyEnabled ? keyText.trim() : undefined,
        expireMinutes,
        maxUses: Math.floor(maxUses),
      })
      if (res.code === 0 && res.data) {
        setResult(res.data)
        onCreated()
        toast.success(`分享创建成功（${res.data.fileCount} 个文件）`)
      } else {
        toast.error(res.msg || "分享创建失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "分享创建失败")
    } finally {
      setSubmitting(false)
    }
  }

  const totalBytes = rows.reduce((s, r) => s + r.size, 0)
  const fullUrl = result ? `${window.location.origin}${result.url}` : ""

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-teal-600" />
            {result ? "分享创建成功" : "创建公开分享"}
          </DialogTitle>
          <DialogDescription>
            {result ? (
              <>链接与密钥仅本次展示，请立即保存（密钥哈希入库，平台也无法回显明文）。</>
            ) : (
              <>
                已选 {rows.length} 个文件 · 共 {fmtBytes(totalBytes)}
                {rows.length <= 3 && rows.length > 0 && (
                  <span className="block truncate">（{rows.map((r) => r.fileName).join("、")}）</span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            {/* 分享名称 */}
            <div className="space-y-1.5">
              <Label htmlFor="share-name">分享名称（可选）</Label>
              <Input
                id="share-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={rows.length === 1 ? rows[0].fileName : `${rows[0]?.fileName ?? "文件"} 等 ${rows.length} 个文件`}
                maxLength={120}
              />
            </div>

            {/* 权限 */}
            <div className="space-y-1.5">
              <Label>访客权限</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setPermission("VIEW")}
                  className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                    permission === "VIEW" ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30" : "hover:bg-muted/50"
                  }`}
                >
                  <span className="font-medium">仅预览（VIEW）</span>
                  <span className="block text-xs text-muted-foreground">访客只能在线查看</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPermission("DOWNLOAD")}
                  className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                    permission === "DOWNLOAD" ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30" : "hover:bg-muted/50"
                  }`}
                >
                  <span className="font-medium">可下载（DOWNLOAD）</span>
                  <span className="block text-xs text-muted-foreground">访客可预览并下载</span>
                </button>
              </div>
            </div>

            {/* 访客密钥 */}
            <div className="space-y-1.5 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="share-key" className="cursor-pointer">访客密钥保护</Label>
                  <p className="text-xs text-muted-foreground">开启后访客需输入密钥才能查看（SHA-256 哈希存储）</p>
                </div>
                <Switch checked={keyEnabled} onCheckedChange={setKeyEnabled} aria-label="开关访客密钥" />
              </div>
              {keyEnabled && (
                <div className="flex gap-2 pt-1">
                  <Input
                    id="share-key"
                    value={keyText}
                    onChange={(e) => setKeyText(e.target.value)}
                    placeholder="至少 4 个字符"
                    maxLength={64}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setKeyText(randomKey(8))}
                    title="生成随机 8 位密钥"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> 随机生成
                  </Button>
                </div>
              )}
            </div>

            {/* 有效期 */}
            <div className="space-y-1.5">
              <Label>有效期</Label>
              <div className="flex flex-wrap gap-1.5">
                {EXPIRE_CHIPS.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setExpireMode(c.key)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      expireMode === c.key ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30 font-medium" : "hover:bg-muted/50"
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setExpireMode("forever")}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    expireMode === "forever" ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30 font-medium" : "hover:bg-muted/50"
                  }`}
                >
                  永久
                </button>
                <button
                  type="button"
                  onClick={() => setExpireMode("custom")}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    expireMode === "custom" ? "border-teal-600 bg-teal-50 dark:bg-teal-950/30 font-medium" : "hover:bg-muted/50"
                  }`}
                >
                  自定义
                </button>
              </div>
              {expireMode === "custom" && (
                <div className="w-48">
                  <PrecisionInput value={customMinutes} onChange={(v) => setCustomMinutes(Math.max(1, Math.round(v)))} min={1} max={525600} step={1} suffix="分钟" />
                </div>
              )}
            </div>

            {/* 次数上限 */}
            <div className="space-y-1.5">
              <Label>最大访问次数</Label>
              <div className="w-48">
                <PrecisionInput value={maxUses} onChange={(v) => setMaxUses(Math.max(0, Math.round(v)))} min={0} max={1000000} step={1} suffix="次" />
              </div>
              <p className="text-xs text-muted-foreground">0 = 不限次数；达到上限后链接自动失效</p>
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed border-t pt-3">
              安全说明：分享 token 为 32 字节随机 hex（128bit 熵，不可枚举猜测）；过期 / 撤销 / 超次 / 密钥错误统一拒绝（不区分原因细节，防探测）；全部访问行为审计留痕。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-sm font-medium">
                {result.fileCount} 个文件 · {fmtBytes(result.totalBytes)}
                {result.expireAt ? ` · ${new Date(result.expireAt).toLocaleString("zh-CN")} 过期` : " · 永久有效"}
              </span>
            </div>

            {/* 分享链接 */}
            <div className="space-y-1.5">
              <Label>分享链接（公开访问，无需登录）</Label>
              <div className="flex gap-2">
                <Input readOnly value={fullUrl} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copy(fullUrl, "链接")}>
                  <Copy className="h-3.5 w-3.5" /> 复制
                </Button>
              </div>
            </div>

            {/* 访客密钥（一次性展示） */}
            {result.visitorKeyPlain && (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  访客密钥
                  <Badge variant="destructive" className="text-[10px]">仅本次展示</Badge>
                </Label>
                <div className="flex gap-2">
                  <Input readOnly value={result.visitorKeyPlain} className="font-mono" onFocus={(e) => e.target.select()} />
                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copy(result.visitorKeyPlain!, "密钥")}>
                    <Copy className="h-3.5 w-3.5" /> 复制
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">在浏览器中打开链接验证效果</p>
                <p className="font-mono text-[10px] text-muted-foreground truncate">token: {result.token}</p>
              </div>
              <Button variant="secondary" size="sm" asChild>
                <a href={result.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3.5 w-3.5" /> 打开验证
                </a>
              </Button>
            </div>

            <Button variant="outline" className="w-full" onClick={() => setResult(null)}>
              继续创建新分享
            </Button>
          </div>
        )}

        {!result && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void submit()} disabled={submitting}>
              {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              创建分享
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function fmtBytes(n: number): string {
  if (!n) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Math.round(v * 1000) / 1000} ${units[i]}`
}
