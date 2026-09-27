"use client"

// 个人资料表单：显示名（可改）/ 邮箱（只读提示换绑）/ 主题偏好三选一卡片 / 表格每页条数

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Mail, Monitor, Moon, Save, Sun } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { updateProfileAction } from "@/server/actions/profile"

interface ProfileFormProps {
  username: string
  displayName: string
  email: string
  emailVerified: boolean
  theme: "light" | "dark" | "system"
  pageSize: number
  role: string
}

const THEME_OPTIONS: { key: "light" | "dark" | "system"; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: "light", label: "浅色", desc: "明亮界面", icon: <Sun className="h-5 w-5" /> },
  { key: "dark", label: "深色", desc: "夜间护眼", icon: <Moon className="h-5 w-5" /> },
  { key: "system", label: "跟随系统", desc: "自动切换", icon: <Monitor className="h-5 w-5" /> },
]

export function ProfileForm({ username, displayName, email, emailVerified, theme, pageSize, role }: ProfileFormProps) {
  const router = useRouter()
  const [fDisplayName, setFDisplayName] = React.useState(displayName)
  const [fTheme, setFTheme] = React.useState<"light" | "dark" | "system">(theme)
  const [fPageSize, setFPageSize] = React.useState(String(pageSize))
  const [saving, setSaving] = React.useState(false)

  const dirty = fDisplayName !== displayName || fTheme !== theme || Number(fPageSize) !== pageSize

  const save = async () => {
    if (fDisplayName.length > 64) {
      toast.error("显示名最长 64 字符")
      return
    }
    setSaving(true)
    try {
      const res = await updateProfileAction({
        displayName: fDisplayName,
        theme: fTheme,
        pageSize: Number(fPageSize),
      })
      if (res.code !== 0) {
        toast.error(res.msg)
        return
      }
      toast.success("个人资料已保存")
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">基本资料与界面偏好</CardTitle>
        <CardDescription>显示名会展示在页面问候与协作场景中；邮箱为账号核心凭证，不可在此修改</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="displayName">显示名</Label>
            <Input
              id="displayName"
              value={fDisplayName}
              onChange={(e) => setFDisplayName(e.target.value)}
              placeholder={username}
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">留空时将展示用户名 {username}</p>
          </div>
          <div className="space-y-1.5">
            <Label>邮箱（只读）</Label>
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-full items-center gap-2 rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{email || "未绑定邮箱"}</span>
              </div>
              {email && (
                <Badge variant={emailVerified ? "default" : "outline"} className={cn("shrink-0", emailVerified && "bg-emerald-600 hover:bg-emerald-600")}>
                  {emailVerified ? "已验证" : "未验证"}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              需要换绑邮箱？请前往
              <a href="/account/security" className="text-teal-600 underline ml-0.5">账号安全</a>
              页面操作
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>界面主题偏好</Label>
          <div className="grid grid-cols-3 gap-3 max-w-md" role="radiogroup" aria-label="界面主题偏好">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={fTheme === opt.key}
                onClick={() => setFTheme(opt.key)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border p-4 transition-all cursor-pointer",
                  fTheme === opt.key
                    ? "border-teal-600 bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 shadow-sm"
                    : "border-input hover:bg-muted/50"
                )}
              >
                {opt.icon}
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.desc}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">偏好将保存在账号资料中，跨设备跟随（当前浏览器主题跟随系统设置）</p>
        </div>

        <div className="space-y-1.5 max-w-xs">
          <Label>列表每页条数</Label>
          <Select value={fPageSize} onValueChange={setFPageSize}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">每页 10 条</SelectItem>
              <SelectItem value="20">每页 20 条</SelectItem>
              <SelectItem value="50">每页 50 条</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">适用于工作区、模板、审计等分页列表的默认每页数量</p>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button onClick={save} disabled={saving || !dirty} className="bg-teal-600 hover:bg-teal-700">
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            保存修改
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">有未保存的修改</span>}
          {!dirty && role && <span className="text-xs text-muted-foreground">当前资料已与服务器同步</span>}
        </div>
      </CardContent>
    </Card>
  )
}
