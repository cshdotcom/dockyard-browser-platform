"use client"

// 头像上传卡片：上传（拖拽/点击选择）· 预览 · 删除恢复默认
// 存储：用户独立空间（storage/avatars/<userId>/avatar.webp）；sharp 256x256 居中裁剪

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Camera, ImagePlus, Loader2, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { UserAvatar } from "@/components/shared/user-avatar"

const MAX_SIZE = 5 * 1024 * 1024
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif"

export function AvatarCard({ userId, name, hasAvatar }: { userId: string; name: string; hasAvatar: boolean }) {
  const router = useRouter()
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [ver, setVer] = React.useState(0) // 强制头像 URL 刷新（绕过缓存）

  const doUpload = async (file: File) => {
    if (file.size > MAX_SIZE) {
      toast.error("头像文件超过 5MB 上限")
      return
    }
    if (!ACCEPT.split(",").includes(file.type)) {
      toast.error(`不支持的格式（${file.type || "未知"}），请使用 PNG/JPEG/WebP/GIF`)
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set("file", file)
      const res = await fetch("/api/avatar", { method: "POST", body: fd })
      const json = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
      if (!json || json.code !== 0) {
        toast.error(json?.msg || "上传失败")
        return
      }
      toast.success("头像已更新（全部页面即时生效）")
      setVer((v) => v + 1)
      router.refresh()
    } catch {
      toast.error("网络错误，上传失败")
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  const doRemove = async () => {
    setBusy(true)
    try {
      const res = await fetch("/api/avatar", { method: "DELETE" })
      const json = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null
      if (!json || json.code !== 0) {
        toast.error(json?.msg || "操作失败")
        return
      }
      toast.success("已恢复默认头像")
      setVer((v) => v + 1)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Camera className="h-4 w-4 text-teal-600" />
          个人头像
        </CardTitle>
        <CardDescription>支持 PNG / JPEG / WebP / GIF，≤5MB；自动裁剪为 256×256 并压缩存储在你独立的账号空间内</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <div className="relative group">
            {hasAvatar ? (
              <img
                key={ver}
                src={`/api/avatar?userId=${encodeURIComponent(userId)}${ver ? `&_v=${ver}` : ""}`}
                alt="当前头像"
                className="h-20 w-20 rounded-full object-cover border-2 border-border shadow-sm"
              />
            ) : (
              <UserAvatar userId={null} name={name} size={80} />
            )}
            {busy && (
              <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                <Loader2 className="h-6 w-6 text-white animate-spin" />
              </div>
            )}
          </div>

          <div
            className={cn(
              "flex-1 w-full rounded-lg border-2 border-dashed p-5 text-center transition-colors cursor-pointer",
              dragOver ? "border-teal-500 bg-teal-50/60 dark:bg-teal-950/30" : "border-input hover:border-teal-300 hover:bg-muted/40",
            )}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) void doUpload(f)
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            aria-label="上传头像（点击或拖拽）"
          >
            <ImagePlus className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">点击选择或拖拽图片到此处</p>
            <p className="mt-0.5 text-xs text-muted-foreground">上传后自动居中裁剪为正方形 · WebP 压缩存储</p>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void doUpload(f)
              }}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
            上传新头像
          </Button>
          {hasAvatar && (
            <Button size="sm" variant="outline" onClick={doRemove} disabled={busy} className="text-red-600 hover:text-red-700">
              <Trash2 className="mr-1 h-4 w-4" />
              恢复默认
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
