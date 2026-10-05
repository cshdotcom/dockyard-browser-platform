"use client"

// r37：Playground 控制台（客户端）
//   · 沙箱选择（运行态优先/状态徽章）
//   · 7 个动作：连接测试（playgroundTicketTestAction）+ 6 个 CDP 动作（playgroundRunAction）
//   · 结果面板：JSON pretty / 截图与 PDF 内联预览（img / iframe）
//   · JS 快捷模板（读取当前 URL / 标题 / DOM 节点数 / cookie 概览）

import * as React from "react"
import { Loader2, Play, Terminal, Camera, Printer, ListTree, Activity, Gauge, ExternalLink, Copy, CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { playgroundRunAction, playgroundTicketTestAction } from "@/server/actions/playground"

interface WorkspaceOption {
  id: string
  name: string
  status: string
  mode: string
  cdpUrl: string | null
}

const JS_TEMPLATES: Array<{ label: string; code: string }> = [
  { label: "当前页面信息", code: "JSON.stringify({ url: location.href, title: document.title, dom: document.getElementsByTagName('*').length })" },
  { label: "视口与 UA", code: "JSON.stringify({ w: innerWidth, h: innerHeight, ua: navigator.userAgent, lang: navigator.language })" },
  { label: "链接统计", code: "JSON.stringify({ links: document.querySelectorAll('a').length, images: document.querySelectorAll('img').length, forms: document.querySelectorAll('form').length })" },
  { label: "Cookie 概览", code: "document.cookie.split(';').map(c => c.trim().split('=')[0]).join(', ')" },
]

export function PlaygroundConsole({ enabled, workspaces }: { enabled: boolean; workspaces: WorkspaceOption[] }) {
  const [wsId, setWsId] = React.useState<string>(workspaces[0]?.id || "")
  const [busy, setBusy] = React.useState("")
  const [result, setResult] = React.useState<{ kind: "json"; data: unknown; durationMs: number; action: string } | { kind: "image"; b64: string } | { kind: "pdf"; b64: string; bytes: number } | { kind: "probe"; reachable: boolean; detail: string } | null>(null)
  const [jsCode, setJsCode] = React.useState(JS_TEMPLATES[0].code)
  const [navUrl, setNavUrl] = React.useState("https://example.com")
  const [copied, setCopied] = React.useState(false)

  const selected = workspaces.find((w) => w.id === wsId)
  const running = selected?.status === "RUNNING" || selected?.status === "IDLE"

  const runAction = async (action: string, params?: Record<string, unknown>) => {
    if (!wsId) return toast.error("请先选择沙箱")
    if (!running) return toast.error("沙箱未运行（请先启动工作区）")
    setBusy(action)
    try {
      if (action === "probe") {
        const res = await playgroundTicketTestAction({ workspaceId: wsId })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "测试失败")
        setResult({ kind: "probe", ...(res.data as { reachable: boolean; detail: string }) })
      } else if (action === "screenshot") {
        const res = await playgroundRunAction({ workspaceId: wsId, action, params: { format: "png" } })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "执行失败")
        const d = res.data as unknown as { dataBase64: string }
        setResult({ kind: "image", b64: d.dataBase64 })
      } else if (action === "print_pdf") {
        const res = await playgroundRunAction({ workspaceId: wsId, action, params: {} })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "执行失败")
        const d = res.data as unknown as { dataBase64: string; bytes: number }
        setResult({ kind: "pdf", b64: d.dataBase64, bytes: d.bytes || 0 })
      } else {
        const res = await playgroundRunAction({ workspaceId: wsId, action, params })
        if (res.code !== 0 || !res.data) throw new Error(res.msg || "执行失败")
        setResult({ kind: "json", data: res.data, durationMs: res.data.durationMs ?? 0, action })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "执行失败")
    } finally {
      setBusy("")
    }
  }

  if (!enabled) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          管理员已停用 Playground（feature.playground）。
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
      {/* 左：沙箱选择 + 动作面板 */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">选择沙箱</CardTitle>
            <CardDescription>运行中的沙箱可执行全部动作</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={wsId} onValueChange={setWsId}>
              <SelectTrigger><SelectValue placeholder="选择工作区" /></SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name} · {w.mode === "novnc_full" ? "VNC" : "CDP"} · {w.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <Badge variant={running ? "default" : "outline"} className={running ? "bg-teal-600 hover:bg-teal-600" : ""}>{selected.status}</Badge>
                <Badge variant="secondary">{selected.mode === "novnc_full" ? "VNC 完整" : "CDP 轻量"}</Badge>
                <Badge variant="outline">CDP 端点{selected.cdpUrl ? "已就绪" : "未探测"}</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">动作</CardTitle>
            <CardDescription>页面对沙箱执行 CDP 级操作</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("probe")}>
                {busy === "probe" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Gauge className="mr-1 h-4 w-4" />} 连接测试
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("status")}>
                {busy === "status" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Activity className="mr-1 h-4 w-4" />} 会话状态
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("debug_info")}>
                {busy === "debug_info" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ListTree className="mr-1 h-4 w-4" />} 调试信息
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("get_tabs")}>
                {busy === "get_tabs" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-1 h-4 w-4" />} 目标列表
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("screenshot")}>
                {busy === "screenshot" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Camera className="mr-1 h-4 w-4" />} 页面截图
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("print_pdf")}>
                {busy === "print_pdf" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Printer className="mr-1 h-4 w-4" />} 打印 PDF
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Terminal className="h-4 w-4" /> 执行 JS</CardTitle>
            <CardDescription>在当前页面上下文执行表达式（Runtime.evaluate）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {JS_TEMPLATES.map((t) => (
                <button key={t.label} onClick={() => setJsCode(t.code)} className="text-[11px] px-2 py-1 rounded-md border bg-muted/40 hover:bg-muted transition-colors">
                  {t.label}
                </button>
              ))}
            </div>
            <Textarea value={jsCode} onChange={(e) => setJsCode(e.target.value)} rows={4} className="font-mono text-xs" placeholder="JS 表达式" />
            <Button size="sm" className="w-full bg-teal-600 hover:bg-teal-700" disabled={!!busy || !jsCode.trim()} onClick={() => void runAction("evaluate", { expression: jsCode })}>
              {busy === "evaluate" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />} 执行
            </Button>
            <div className="space-y-1.5">
              <Label className="text-xs">导航测试（navigate）</Label>
              <div className="flex gap-2">
                <input
                  className="flex-1 h-8 rounded-md border bg-transparent px-2 text-xs" value={navUrl}
                  onChange={(e) => setNavUrl(e.target.value)} placeholder="https://example.com"
                />
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runAction("navigate", { url: navUrl, waitMs: 2000 })}>
                  {busy === "navigate" ? <Loader2 className="h-4 w-4 animate-spin" /> : "导航"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 右：结果面板 */}
      <Card className="min-h-[400px]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">结果</CardTitle>
          <CardDescription>
            {result ? (result.kind === "probe" ? "CDP 端点拨测结果" : result.kind === "image" ? "页面截图预览" : result.kind === "pdf" ? "打印渲染预览（可打印到本地打印机）" : `动作 ${result.action} · ${result.durationMs}ms`) : "执行左侧动作后在此查看结果"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!result && (
            <div className="py-16 text-center text-sm text-muted-foreground">
              选择沙箱 → 执行动作（建议先「连接测试」验证 CDP 链路健康）
            </div>
          )}
          {result?.kind === "probe" && (
            <div className={`rounded-md border p-3 ${result.reachable ? "border-teal-300 bg-teal-50/60 dark:bg-teal-950/30 dark:border-teal-800" : "border-red-300 bg-red-50/60 dark:bg-red-950/30 dark:border-red-800"}`}>
              <p className="text-sm font-medium flex items-center gap-2">
                {result.reachable ? <CheckCircle2 className="h-4 w-4 text-teal-600" /> : <Activity className="h-4 w-4 text-red-600" />}
                {result.reachable ? "端点可达" : "端点异常"}
              </p>
              <p className="text-xs text-muted-foreground mt-1 break-all">{result.detail}</p>
            </div>
          )}
          {result?.kind === "image" && (
             
            <img src={`data:image/png;base64,${result.b64}`} alt="页面截图" className="max-w-full rounded-md border" />
          )}
          {result?.kind === "pdf" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{(result.bytes / 1024).toFixed(1)} KB</Badge>
                <Button size="sm" variant="outline" onClick={() => {
                  const bin = atob(result.b64)
                  const bytes = new Uint8Array(bin.length)
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
                  const blob = new Blob([bytes], { type: "application/pdf" })
                  const url = URL.createObjectURL(blob)
                  const w = window.open(url, "_blank")
                  if (w) setTimeout(() => URL.revokeObjectURL(url), 60_000)
                }}>
                  <ExternalLink className="mr-1 h-4 w-4" /> 新窗口打开
                </Button>
                <Button size="sm" variant="outline" onClick={() => {
                  const bin = atob(result.b64)
                  const bytes = new Uint8Array(bin.length)
                  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
                  printBlob(new Blob([bytes], { type: "application/pdf" }))
                }}>
                  <Printer className="mr-1 h-4 w-4" /> 发送到本地打印机
                </Button>
              </div>
              <iframe title="pdf-preview" src={`data:application/pdf;base64,${result.b64}`} className="w-full h-[540px] rounded-md border" />
            </div>
          )}
          {result?.kind === "json" && (
            <div className="space-y-2">
              <Button size="sm" variant="ghost" onClick={async () => {
                try { await navigator.clipboard.writeText(JSON.stringify(result.data, null, 2)) } catch { /* noop */ }
                setCopied(true); setTimeout(() => setCopied(false), 1500)
              }}>
                {copied ? <CheckCircle2 className="mr-1 h-4 w-4 text-teal-600" /> : <Copy className="mr-1 h-4 w-4" />} 复制 JSON
              </Button>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 max-h-[560px] overflow-auto">
                {JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** PDF blob → 隐藏 iframe 打印（触发本地打印机对话框） */
function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const iframe = document.createElement("iframe")
  iframe.style.position = "fixed"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "none"
  iframe.src = url
  iframe.onload = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() } catch { /* noop */ }
    setTimeout(() => { URL.revokeObjectURL(url); iframe.remove() }, 60_000)
  }
  document.body.appendChild(iframe)
}
