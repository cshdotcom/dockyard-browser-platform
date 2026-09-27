"use client"

// 多文件上传组件：XHR 进度条 + 后缀/魔数/配额校验（服务端）+ 病毒扫描联动

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, UploadCloud, ShieldCheck, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { fmtBytesClient } from "./fmt"

interface UploadItem {
  uid: string
  file: File
  progress: number
  status: "pending" | "uploading" | "done" | "rejected"
  message?: string
}

interface UploadCardProps {
  quotaMb: number
  totalUsedBytes: number
  virusScanEnabled: boolean
}

export function UploadCard({ quotaMb, totalUsedBytes, virusScanEnabled }: UploadCardProps) {
  const router = useRouter()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [items, setItems] = React.useState<UploadItem[]>([])
  const [uploading, setUploading] = React.useState(false)
  const [scanning, setScanning] = React.useState(0)

  const updateItem = (uid: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)))
  }

  const pickFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return
    const next: UploadItem[] = []
    for (const f of Array.from(files).slice(0, 20)) {
      next.push({ uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file: f, progress: 0, status: "pending" })
    }
    setItems((prev) => [...prev, ...next])
  }

  // 单文件 XHR 上传（带进度）
  const uploadOne = (item: UploadItem) =>
    new Promise<{ ok: boolean; id?: string; reason?: string }>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", "/api/files/upload")
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          updateItem(item.uid, { progress: Math.round((e.loaded / e.total) * 100), status: "uploading" })
        }
      }
      xhr.onload = () => {
        try {
          const json = JSON.parse(xhr.responseText) as {
            code: number
            msg: string
            data?: { uploaded: { id: string; fileName: string }[]; rejected: { fileName: string; reason: string }[] }
          }
          if (json.code === 0 && json.data) {
            const mine = json.data.uploaded.find((u) => u.fileName === item.file.name)
            const mineRejected = json.data.rejected.find((u) => u.fileName === item.file.name)
            if (mine) {
              updateItem(item.uid, { progress: 100, status: "done" })
              resolve({ ok: true, id: mine.id })
            } else if (mineRejected) {
              updateItem(item.uid, { status: "rejected", message: mineRejected.reason })
              resolve({ ok: false, reason: mineRejected.reason })
            } else {
              updateItem(item.uid, { status: "rejected", message: json.msg || "上传失败" })
              resolve({ ok: false, reason: json.msg })
            }
          } else {
            updateItem(item.uid, { status: "rejected", message: json.msg || `上传失败（${xhr.status}）` })
            resolve({ ok: false, reason: json.msg })
          }
        } catch {
          updateItem(item.uid, { status: "rejected", message: `上传失败（HTTP ${xhr.status}）` })
          resolve({ ok: false, reason: `HTTP ${xhr.status}` })
        }
      }
      xhr.onerror = () => {
        updateItem(item.uid, { status: "rejected", message: "网络错误" })
        resolve({ ok: false, reason: "网络错误" })
      }
      const fd = new FormData()
      fd.append("files", item.file)
      fd.append("category", "GENERAL")
      xhr.send(fd)
    })

  const startUpload = async () => {
    const pending = items.filter((it) => it.status === "pending")
    if (pending.length === 0) {
      toast.info("没有待上传的文件")
      return
    }
    setUploading(true)
    let success = 0
    const uploadedIds: string[] = []
    try {
      for (const it of pending) {
        const r = await uploadOne(it)
        if (r.ok && r.id) {
          success++
          uploadedIds.push(r.id)
        }
      }
      // 病毒扫描开关开启时：对每个成功上传的文件调用扫描接口
      if (virusScanEnabled && uploadedIds.length > 0) {
        setScanning(uploadedIds.length)
        for (const id of uploadedIds) {
          try {
            await fetch("/api/files/scan", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileId: id }),
            })
          } catch { /* 扫描失败不阻断上传结果 */ }
          setScanning((n) => n - 1)
        }
        toast.success(`已上传 ${success} 个文件，病毒扫描完成`)
      } else {
        toast.success(`上传完成：成功 ${success} 个文件`)
      }
      router.refresh()
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <UploadCloud className="h-4 w-4 text-teal-600" />
          <span className="font-medium">上传文件</span>
          {virusScanEnabled ? (
            <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-[10px]">
              <ShieldCheck className="mr-1 h-3 w-3" />
              病毒扫描已开启
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600 border-amber-200 text-[10px]">病毒扫描未开启</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          单用户配额 {quotaMb}MB · 平台已用 {fmtBytesClient(totalUsedBytes)} · 黑名单后缀 .exe/.sh/.bat/.cmd/.msi/.dll/.so · 魔数校验 MZ/ELF
        </p>
      </div>

      <div
        className="rounded-lg border border-dashed p-6 text-center cursor-pointer hover:border-teal-500 hover:bg-teal-50/40 dark:hover:bg-teal-950/10 transition-colors"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          pickFiles(e.dataTransfer.files)
        }}
        role="button"
        aria-label="选择或拖入文件"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => pickFiles(e.target.files)}
        />
        <UploadCloud className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">点击选择或拖入文件（支持多选，单文件 ≤ 100MB）</p>
      </div>

      {items.length > 0 && (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {items.map((it) => (
            <div key={it.uid} className="flex items-center gap-3 rounded-md border p-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm truncate">{it.file.name}</p>
                  <span className="text-xs text-muted-foreground shrink-0">{fmtBytesClient(it.file.size)}</span>
                </div>
                {it.status === "rejected" ? (
                  <p className="text-xs text-red-600">{it.message}</p>
                ) : it.status === "done" ? (
                  <p className="text-xs text-emerald-600">上传成功{virusScanEnabled ? " · 病毒扫描已执行" : ""}</p>
                ) : (
                  <Progress value={it.progress} className="h-1.5" />
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setItems((prev) => prev.filter((x) => x.uid !== it.uid))}
                disabled={uploading && it.status === "uploading"}
                aria-label="移除"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {scanning > 0 ? `病毒扫描进行中（剩余 ${scanning} 个）…` : "上传走 /api/files/upload，逐文件校验后写入本地存储并登记 fileMeta"}
        </p>
        <Button onClick={startUpload} disabled={uploading || items.filter((i) => i.status === "pending").length === 0}>
          {uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-1 h-4 w-4" />}
          开始上传（{items.filter((i) => i.status === "pending").length} 个待传）
        </Button>
      </div>
    </div>
  )
}
