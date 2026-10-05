"use client"

// r37：远程打印按钮（沙箱页面 → 客户端本地打印机）
// 流程：POST /api/vnc-proxy/print → PDF 流 → 隐藏 iframe print() → 系统打印对话框
//（用户选择本地/网络打印机；服务端与沙箱零中间文件落盘）

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

export function RemotePrintButton({ workspaceId, disabled }: { workspaceId: string; disabled?: boolean }) {
  const [busy, setBusy] = React.useState(false)
  const router = useRouter()

  const print = async () => {
    setBusy(true)
    try {
      const res = await fetch("/api/vnc-proxy/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { msg?: string } | null
        throw new Error(j?.msg || `打印失败（HTTP ${res.status}）`)
      }
      const blob = await res.blob()
      if (blob.size < 100) throw new Error("打印渲染结果为空（页面可能无可打印内容）")
      const url = URL.createObjectURL(blob)
      const iframe = document.createElement("iframe")
      iframe.style.position = "fixed"
      iframe.style.width = "0"
      iframe.style.height = "0"
      iframe.style.border = "none"
      iframe.src = url
      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus()
          iframe.contentWindow?.print()
          toast.success("已唤起本地打印对话框（在对话框中选择打印机）")
        } catch {
          // 部分浏览器拦截 iframe 打印 → 新窗口兜底
          window.open(url, "_blank")
        }
        setTimeout(() => { URL.revokeObjectURL(url); iframe.remove() }, 120_000)
      }
      document.body.appendChild(iframe)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "打印失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={() => void print()} disabled={busy || disabled} title="渲染沙箱当前页面并发送到你的本地打印机">
      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Printer className="mr-1 h-4 w-4" />}
      打印当前页面到本地打印机
    </Button>
  )
}
