"use client"

// ============================================================
// r35 订阅一键导入对话框（用户点名功能）
// 流程：输入订阅链接（或粘贴内容）→ 服务端拉取+解析预览（SSRF 防护）
// → 勾选节点子集 + 路由模式（全局代理/直连/规则）→ 一键创建 SingBox 实例
// 兼容：base64 订阅 / 明文 URI 列表 / Clash YAML（vmess/vless/ss/trojan/socks/http）
// ============================================================
import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Link2, Loader2, Download, CheckCircle2, Globe, ArrowRight, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { parseSubscriptionAction, importSubscriptionAction } from "@/server/actions/singbox"
import { cn } from "@/lib/utils"

interface PreviewNode { tag: string; type: string; server: string; serverPort: number; name: string }

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
}

const FORMAT_LABEL: Record<string, string> = {
  "base64-uri-list": "Base64 订阅（v2rayN 格式）",
  "uri-list": "明文 URI 列表",
  "clash-yaml": "Clash YAML",
  unknown: "未识别",
}

export function SubscriptionImportDialog({ open, onOpenChange }: Props) {
  const router = useRouter()
  const [url, setUrl] = React.useState("")
  const [content, setContent] = React.useState("")
  const [parsing, setParsing] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [preview, setPreview] = React.useState<{
    format: string; total: number; failed: number; nodes: PreviewNode[]
  } | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [instanceName, setInstanceName] = React.useState("")
  const [mode, setMode] = React.useState<"rule" | "proxy" | "direct">("rule")

  const reset = () => {
    setPreview(null); setSelected(new Set()); setUrl(""); setContent(""); setInstanceName("")
  }

  const doParse = async () => {
    if (!url.trim() && !content.trim()) { toast.error("请输入订阅链接或粘贴订阅内容"); return }
    setParsing(true)
    try {
      const res = await parseSubscriptionAction({ url: url.trim(), content })
      if (res.code === 0 && res.data) {
        setPreview(res.data)
        setSelected(new Set(res.data.nodes.map((n) => n.tag))) // 默认全选
        if (!instanceName) {
          const host = url.trim() ? new URL(url.trim()).hostname : "粘贴订阅"
          setInstanceName(`订阅-${host.slice(0, 40)}-${new Date().toISOString().slice(5, 10).replace("-", "")}`)
        }
        toast.success(`解析成功：${res.data.nodes.length}/${res.data.total} 个节点（${FORMAT_LABEL[res.data.format] || res.data.format}）`)
      } else toast.error(res.msg)
    } finally { setParsing(false) }
  }

  const doImport = async () => {
    if (!preview) return
    if (selected.size === 0) { toast.error("请至少勾选一个节点"); return }
    if (!instanceName.trim()) { toast.error("请填写实例名称"); return }
    setImporting(true)
    try {
      const res = await importSubscriptionAction({
        url: url.trim(), content,
        name: instanceName.trim(),
        mode,
        selectedTags: Array.from(selected),
      })
      if (res.code === 0 && res.data) {
        toast.success(`已导入 ${res.data.imported} 个节点并创建实例（跳过 ${res.data.skipped}）`)
        onOpenChange(false)
        reset()
        router.refresh()
      } else toast.error(res.msg)
    } finally { setImporting(false) }
  }

  const toggle = (tag: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag); else next.add(tag)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!importing) { onOpenChange(v); if (!v) reset() } }}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Download className="h-4 w-4" />订阅一键导入</DialogTitle>
          <DialogDescription>
            输入机场/自建订阅链接，完全模拟真实客户端解析（兼容 Base64 订阅 / 明文 URI / Clash YAML；
            vmess / vless / ss / trojan / socks / http 协议）。服务端拉取带 SSRF 防护与频率限制。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm">订阅链接</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/api/v1/client/subscribe?token=..." className="pl-8 font-mono text-xs" disabled={!!preview} />
              </div>
              <Button onClick={() => void doParse()} disabled={parsing || (!url.trim() && !content.trim())}>
                {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
                {preview ? "重新解析" : "拉取并解析"}
              </Button>
            </div>
          </div>

          <details className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">或粘贴订阅内容（明文 / Base64 / Clash YAML）</summary>
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={"vmess://eyJ2Ijoi...\nvless://uuid@host:443?...\nss://..."} className="mt-2 min-h-[96px] font-mono text-[11px]" disabled={!!preview} />
          </details>

          {preview && (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                <Badge variant="secondary">{FORMAT_LABEL[preview.format] || preview.format}</Badge>
                <span>解析 <b className="text-primary">{preview.nodes.length}</b>/{preview.total} 节点</span>
                {preview.failed > 0 && <span className="text-amber-600">{preview.failed} 行无法识别（已跳过）</span>}
                <div className="ml-auto flex items-center gap-1">
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSelected(new Set(preview.nodes.map((n) => n.tag)))}>全选</Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setSelected(new Set())}>清空</Button>
                </div>
              </div>

              <div className="max-h-56 overflow-y-auto rounded-md border">
                {preview.nodes.map((n) => (
                  <label key={n.tag} className="flex cursor-pointer items-center gap-2 border-b px-2.5 py-1.5 text-xs last:border-b-0 hover:bg-muted/40">
                    <input type="checkbox" checked={selected.has(n.tag)} onChange={() => toggle(n.tag)} className="h-3.5 w-3.5" />
                    <Badge variant="outline" className="w-16 justify-center font-mono text-[10px] uppercase">{n.type}</Badge>
                    <span className="min-w-0 flex-1 truncate" title={n.name}>{n.name}</span>
                    <span className="hidden shrink-0 text-muted-foreground font-mono sm:inline">{n.server}:{n.serverPort}</span>
                  </label>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">实例名称</Label>
                  <Input value={instanceName} onChange={(e) => setInstanceName(e.target.value)} placeholder="订阅实例名称" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">路由模式</Label>
                  <Select value={mode} onValueChange={(v: "rule" | "proxy" | "direct") => setMode(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rule"><span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" />规则模式（国内直连）</span></SelectItem>
                      <SelectItem value="proxy"><ArrowRight className="h-3.5 w-3.5" />全局代理</SelectItem>
                      <SelectItem value="direct">全局直连</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-teal-500" />
                已选 <b className="text-primary">{selected.size}</b> 个节点将作为出站创建；规则模式自动附加 geosite:cn / geoip:cn 直连规则
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>取消</Button>
          <Button onClick={() => void doImport()} disabled={!preview || selected.size === 0 || importing || !instanceName.trim()}>
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            导入并创建实例（{selected.size || 0} 节点）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
