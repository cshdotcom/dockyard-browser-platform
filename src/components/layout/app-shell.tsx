"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  LayoutDashboard, Globe, FileCode2, KeyRound, ShieldCheck, Megaphone,
  Users, FolderTree, ScrollText, Settings2, Timer, FolderOpen, DatabaseBackup,
  Bell, Server, Network, Recycle, ShieldAlert, MessageSquareCode,
  ChevronLeft, Menu, LogOut, Search, UserCog, MonitorSmartphone,
  AlertTriangle, CheckCircle2, Loader2, ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { UserAvatar } from "@/components/shared/user-avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { signOut } from "next-auth/react"
import { GlobalAnnouncer } from "@/components/announcements/global-announcer"

export interface MenuItem {
  key: string
  label: string
  href: string
  icon: React.ReactNode
  badge?: number
}
export interface MenuGroup {
  key: string
  label: string
  items: MenuItem[]
}

export interface ShellUser {
  id?: string
  username: string
  displayName?: string | null
  email?: string | null
  role: string
  hasAvatar?: boolean
}

interface AppShellProps {
  user: ShellUser
  menuGroups: MenuGroup[]
  unreadCount: number
  maintenance: boolean
  maintenanceMessage: string
  /** 强制 2FA 门控：true 时非白名单页面被拦截并引导到账号安全页 */
  needs2faSetup?: boolean
  children: React.ReactNode
}

// 2FA 强制门控白名单：仅允许账号安全相关页面（引导开通 2FA 的唯一通道）
const TWOFA_ALLOWED_PATHS = ["/account/security", "/account/sessions", "/account/profile"]

export function AppShell({ user, menuGroups, unreadCount, maintenance, maintenanceMessage, needs2faSetup = false, children }: AppShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)

  // ---- 强制 2FA 门控：非白名单页面立即重定向到账号安全页（管理员开启后即时生效）----
  const twofaBlocked = needs2faSetup && !TWOFA_ALLOWED_PATHS.some((p) => pathname?.startsWith(p))
  React.useEffect(() => {
    if (twofaBlocked) {
      router.replace("/account/security?force2fa=1")
    }
  }, [twofaBlocked, router])

  const roleLabel: Record<string, string> = {
    SUPER_ADMIN: "超级管理员",
    ADMIN: "管理员",
    GROUP_ADMIN: "组管理员",
    USER: "用户",
  }

  return (
    <div className="min-h-screen bg-muted/30 dark:bg-background">
      {maintenance && (
        <div className="bg-amber-500/90 text-white text-center text-sm py-1.5 px-4 sticky top-0 z-50">
          {maintenanceMessage}
        </div>
      )}
      {/* 强制 2FA 门控拦截卡：重定向完成前的即时视觉反馈 */}
      {twofaBlocked && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 backdrop-blur-sm px-4">
          <div className="max-w-md w-full rounded-xl border border-amber-300 dark:border-amber-700 bg-card p-6 text-center shadow-lg">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
              <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <h2 className="text-lg font-semibold mb-2">需要先开启双因素认证（2FA）</h2>
            <p className="text-sm text-muted-foreground mb-4">
              管理员已要求所有账号开启 2FA 后才能使用平台功能。完成设置后即可自动恢复访问。
            </p>
            <Button asChild className="bg-amber-600 hover:bg-amber-700 text-white">
              <Link href="/account/security?force2fa=1">前往开启 2FA</Link>
            </Button>
          </div>
        </div>
      )}
      <div className="flex min-h-screen">
        <aside
          className={cn(
            "hidden md:flex flex-col border-r bg-card transition-all duration-200 sticky top-0 h-screen",
            collapsed ? "w-16" : "w-56"
          )}
        >
          <div className="flex items-center gap-2 h-14 px-4 border-b shrink-0">
            <div className="h-8 w-8 rounded-lg bg-teal-600 flex items-center justify-center text-white font-bold text-sm shrink-0">D</div>
            {!collapsed && <span className="font-semibold text-sm truncate">Dockyard</span>}
          </div>
          <ScrollArea className="flex-1 py-2">
            <nav className="space-y-4 px-2">
              {menuGroups.map((group) => (
                <div key={group.key}>
                  {!collapsed && <p className="px-2 mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>}
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const active = pathname === item.href || pathname.startsWith(item.href + "/")
                      return (
                        <Link
                          key={item.key}
                          href={item.href}
                          title={item.label}
                          className={cn(
                            "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                            active
                              ? "bg-teal-600/10 text-teal-700 dark:text-teal-300 font-medium"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          <span className="shrink-0">{item.icon}</span>
                          {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                          {!collapsed && !!item.badge && item.badge > 0 && (
                            <Badge variant="destructive" className="h-4 px-1 text-[10px]">{item.badge > 99 ? "99+" : item.badge}</Badge>
                          )}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </ScrollArea>
          <Button variant="ghost" size="sm" className="m-2 justify-start" onClick={() => setCollapsed(!collapsed)}>
            <ChevronLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
            {!collapsed && "收起菜单"}
          </Button>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-14 border-b bg-card sticky top-0 z-40 flex items-center gap-2 px-4 shrink-0">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
              <Menu className="h-5 w-5" />
            </Button>
            <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 text-muted-foreground w-9 sm:w-64 justify-start sm:justify-start justify-center shrink-0">
                  <Search className="h-4 w-4" />
                  <span className="hidden sm:inline text-xs">全局搜索（全部资源）</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>全局搜索（工作区/用户/任务/告警等全部资源）</DialogTitle>
                </DialogHeader>
                <GlobalSearch onClose={() => setSearchOpen(false)} />
              </DialogContent>
            </Dialog>

            <div className="ml-auto flex items-center gap-1.5 min-w-0 shrink-0">
              <NotificationBell initial={unreadCount} />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-2 shrink-0">
                    <UserAvatar
                      userId={user.hasAvatar && user.id ? user.id : null}
                      name={user.displayName || user.username}
                      size={28}
                    />
                    <span className="hidden sm:inline text-sm">{user.displayName || user.username}</span>
                    <Badge variant="outline" className="hidden lg:inline text-[10px]">{roleLabel[user.role] || user.role}</Badge>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    {user.username}{user.email ? ` · ${user.email}` : ""}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => router.push("/account/security")}>
                    <ShieldCheck className="mr-2 h-4 w-4" /> 账号安全
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push("/account/profile")}>
                    <UserCog className="mr-2 h-4 w-4" /> 个人资料
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push("/account/sessions")}>
                    <MonitorSmartphone className="mr-2 h-4 w-4" /> 登录设备
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={async () => {
                      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {})
                      await signOut({ redirect: false })
                      // push+refresh 竞态会取消导航；push 自带 RSC 拉取
                      router.push("/login")
                    }}
                  >
                    <LogOut className="mr-2 h-4 w-4" /> 退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>

          {/* 全局公告层：跑马灯（多条合并 +N 折叠）+ 弹窗/强制阅读队列 —— 所有页面顶栏正下方 */}
          <GlobalAnnouncer />

          {mobileOpen && (
            <div className="md:hidden border-b bg-card p-3 space-y-3">
              {menuGroups.map((group) => (
                <div key={group.key}>
                  <p className="px-2 mb-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {group.items.map((item) => (
                      <Link
                        key={item.key}
                        href={item.href}
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-muted"
                      >
                        {item.icon}
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <main className="flex-1 p-4 md:p-6 min-w-0">{children}</main>

          <footer className="mt-auto border-t bg-card py-3 text-center text-xs text-muted-foreground">
            Dockyard 浏览器工作平台 · 企业级远程浏览器编排系统
          </footer>
        </div>
      </div>
    </div>
  )
}

function NotificationBell({ initial }: { initial: number }) {
  const [items, setItems] = React.useState<{ id: string; title: string; content: string; type: string; link: string | null; readAt: string | null; createdAt: string }[]>([])
  const [count, setCount] = React.useState(initial)
  const [open, setOpen] = React.useState(false)
  // 站内信小弹窗：点击一条通知先打开摘要弹窗（标题+≤200字摘要+已读+查看详情）
  const [selected, setSelected] = React.useState<{ id: string; title: string; content: string; type: string; link: string | null; readAt: string | null; createdAt: string } | null>(null)
  const [marking, setMarking] = React.useState(false)
  const router = useRouter()

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/notifications")
      const json = await res.json()
      if (json.code === 0) {
        setItems(json.data.items || [])
        setCount(json.data.unread || 0)
      }
    } catch { /* ignore */ }
  }, [])

  React.useEffect(() => {
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  // ---- 单条标记已读：PATCH 后本地即时更新（已读样式 + 未读计数减一） ----
  const markRead = async (n: NonNullable<typeof selected>): Promise<boolean> => {
    if (n.readAt) return true
    setMarking(true)
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      })
      const json = await res.json()
      if (json.code !== 0) {
        toast.error(json.msg || "标记已读失败")
        return false
      }
      const readAt = (json.data?.readAt as string) || new Date().toISOString()
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt } : x)))
      setSelected((prev) => (prev && prev.id === n.id ? { ...prev, readAt } : prev))
      setCount((c) => Math.max(0, c - 1))
      return true
    } catch {
      toast.error("网络异常，标记已读失败")
      return false
    } finally {
      setMarking(false)
    }
  }

  // 查看详情目标：公告类 → 公告页（link 携带 focus 定位）；其他 → 有 link 才跳转
  const detailLink = (n: NonNullable<typeof selected>): string | null => {
    if (n.type === "ANNOUNCEMENT") return n.link || "/announcements"
    return n.link || null
  }

  const gotoDetail = (n: NonNullable<typeof selected>) => {
    const link = detailLink(n)
    // 查看详情即视为已读（打开公告详情后回转即已读态）
    if (!n.readAt) void markRead(n)
    setSelected(null)
    if (link) router.push(link)
  }

  const typeLabel: Record<string, string> = {
    ANNOUNCEMENT: "公告通知",
    ALERT: "告警通知",
    SYSTEM: "系统通知",
    TOKEN_EXPIRE: "令牌到期",
    SECURITY: "安全通知",
  }
  const TypeIcon = (n: NonNullable<typeof selected>) => {
    if (n.type === "ANNOUNCEMENT") return <Megaphone className="h-4 w-4 text-violet-500 shrink-0" />
    if (n.type === "ALERT") return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
    if (n.type === "TOKEN_EXPIRE") return <KeyRound className="h-4 w-4 text-orange-500 shrink-0" />
    if (n.type === "SECURITY") return <ShieldAlert className="h-4 w-4 text-red-500 shrink-0" />
    return <Bell className="h-4 w-4 text-teal-500 shrink-0" />
  }

  // 摘要：纯文本截断 200 字（弹窗内仍限高滚动，不溢出）
  const summaryOf = (n: NonNullable<typeof selected>) =>
    n.content.length > 200 ? `${n.content.slice(0, 200)}…` : n.content

  return (
    <>
      <DropdownMenu open={open} onOpenChange={(v) => { setOpen(v); if (v) void load() }}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" aria-label={`站内通知（${count} 条未读）`}>
            <Bell className="h-[18px] w-[18px]" />
            {count > 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center">
                {count > 99 ? "99+" : count}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>站内通知</span>
            <button
              className="text-xs text-teal-600 underline"
              onClick={async (e) => {
                e.stopPropagation()
                await fetch("/api/notifications", { method: "PUT" })
                void load()
              }}
            >
              全部已读
            </button>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无通知</p>}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={cn(
                  "block w-full text-left px-3 py-2.5 border-b last:border-0 transition cursor-pointer hover:bg-muted/70",
                  !n.readAt && "bg-teal-600/5",
                )}
                onClick={() => {
                  // 先打开小弹窗（不直接跳转）
                  setOpen(false)
                  setSelected(n)
                }}
              >
                <p className="text-sm font-medium leading-tight flex items-center gap-1.5">
                  {!n.readAt && <span className="h-1.5 w-1.5 rounded-full bg-teal-600 shrink-0" aria-label="未读" />}
                  {n.type === "ANNOUNCEMENT" && <Megaphone className="h-3 w-3 text-violet-500 shrink-0" />}
                  <span className="truncate">{n.title}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.content}</p>
                <p className="mt-1 text-[10px] text-muted-foreground flex items-center gap-1">
                  <span>{new Date(n.createdAt).toLocaleString("zh-CN")}</span>
                  {!n.readAt && <span className="text-teal-600">未读</span>}
                  <span className="ml-auto text-teal-600 inline-flex items-center gap-0.5">详情<ChevronRight className="h-3 w-3" /></span>
                </p>
              </button>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 站内信小弹窗：标题 + ≤200字摘要 + 标记已读 + 查看详情（交互风格同全局公告详情弹窗） */}
      <Dialog open={!!selected} onOpenChange={(v) => { if (!v) setSelected(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6 text-base">
              {selected && TypeIcon(selected)}
              <span className="truncate">{selected?.title}</span>
            </DialogTitle>
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px] font-normal">{selected ? typeLabel[selected.type] || selected.type : ""}</Badge>
              <span>{selected ? new Date(selected.createdAt).toLocaleString("zh-CN") : ""}</span>
            </div>
          </DialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2.5">
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{selected ? summaryOf(selected) : ""}</p>
            {selected && selected.content.length > 200 && (
              <p className="mt-2 text-[11px] text-muted-foreground">内容已截断，点击「查看详情」查看完整内容</p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
            <div className="min-w-0">
              {selected && (selected.readAt ? (
                <Badge variant="outline" className="gap-1 text-xs py-1.5 px-3">
                  <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />
                  {selected.readAt ? `已读于 ${new Date(selected.readAt).toLocaleString("zh-CN")}` : "已读"}
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-600" /> 未读
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setSelected(null)} className="flex-1 sm:flex-none">
                关闭
              </Button>
              {selected && !selected.readAt && (
                <Button
                  variant="secondary"
                  onClick={() => selected && void markRead(selected)}
                  disabled={marking}
                  className="flex-1 sm:flex-none"
                >
                  {marking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4 text-teal-600" />}
                  标记已读
                </Button>
              )}
              {selected && detailLink(selected) && (
                <Button onClick={() => gotoDetail(selected)} className="bg-teal-600 hover:bg-teal-700 flex-1 sm:flex-none">
                  查看详情
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// r23-C：全局搜索增强 —— 筛选栏（类型多选 Chip / 日期范围 / 管理员用户过滤）+ 分组副标题
interface SearchTypeMeta { type: string; label: string; adminOnly: boolean }
interface SearchHit { id: string; label: string; sub?: string; href: string }
interface SearchGroup { group: string; type: string; items: SearchHit[] }

function GlobalSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = React.useState("")
  const [catalog, setCatalog] = React.useState<SearchTypeMeta[]>([])
  const [selectedTypes, setSelectedTypes] = React.useState<Set<string>>(new Set())
  const [from, setFrom] = React.useState("")
  const [to, setTo] = React.useState("")
  const [user, setUser] = React.useState("")
  const [results, setResults] = React.useState<SearchGroup[]>([])
  const [busy, setBusy] = React.useState(false)

  // 目录含管理员专属类型 → 当前为管理员模式，显示「按用户过滤」
  const adminMode = catalog.some((t) => t.adminOnly)
  const typesKey = [...selectedTypes].sort().join(",")

  // 挂载即拉类型目录（空查询也会返回 types 目录）
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch("/api/search?q=")
        const json = await res.json()
        if (alive && json.code === 0 && Array.isArray(json.data?.types)) setCatalog(json.data.types)
      } catch { /* 目录拉取失败不阻断搜索 */ }
    })()
    return () => { alive = false }
  }, [])

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const sp = new URLSearchParams()
        sp.set("q", q.trim())
        if (selectedTypes.size > 0) sp.set("types", typesKey)
        if (from) sp.set("from", from)
        if (to) sp.set("to", to)
        if (adminMode && user.trim()) sp.set("user", user.trim())
        const res = await fetch(`/api/search?${sp.toString()}`)
        const json = await res.json()
        if (json.code === 0) {
          setResults(json.data.groups || [])
          if (Array.isArray(json.data?.types)) setCatalog(json.data.types)
        }
      } catch {
        toast.error("搜索失败")
      } finally {
        setBusy(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q, typesKey, from, to, user, adminMode])

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const hasFilter = selectedTypes.size > 0 || !!from || !!to || (adminMode && !!user.trim())
  const clearFilters = () => {
    setSelectedTypes(new Set())
    setFrom("")
    setTo("")
    setUser("")
  }

  return (
    <div className="space-y-3">
      <Input autoFocus placeholder="输入关键词：名称 / UUID / 用户名 / 告警标题..." value={q} onChange={(e) => setQ(e.target.value)} />

      {/* ---- 筛选栏：类型多选 Chip + 日期范围 + 管理员用户过滤 ---- */}
      {catalog.length > 0 && (
        <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground shrink-0">类型</span>
            <button
              type="button"
              onClick={clearFilters}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors cursor-pointer",
                hasFilter
                  ? "border-border bg-background text-muted-foreground hover:bg-muted"
                  : "border-teal-600 bg-teal-600 text-white"
              )}
              title="清空全部筛选（搜索所有类型）"
            >
              全部
            </button>
            {catalog.map((t) => {
              const on = selectedTypes.has(t.type)
              return (
                <button
                  key={t.type}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleType(t.type)}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs transition-colors cursor-pointer",
                    on
                      ? "border-teal-600 bg-teal-600 text-white"
                      : "border-border bg-background text-muted-foreground hover:bg-muted"
                  )}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground block" htmlFor="gs-from">创建时间 起</label>
              <Input id="gs-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground block" htmlFor="gs-to">创建时间 止</label>
              <Input id="gs-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            {adminMode && (
              <div className="space-y-1 min-w-40 flex-1">
                <label className="text-[11px] text-muted-foreground block" htmlFor="gs-user">按用户过滤（管理员）</label>
                <Input
                  id="gs-user"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="按用户过滤（用户名/邮箱）"
                  className="h-8 text-xs"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {busy && <p className="text-xs text-muted-foreground text-center py-4">搜索中...</p>}
      {!busy && results.length === 0 && q.trim().length >= 2 && (
        <p className="text-xs text-muted-foreground text-center py-4">无匹配结果{hasFilter ? "（可尝试清空筛选）" : ""}</p>
      )}
      <div className="space-y-3 max-h-[60vh] overflow-y-auto">
        {results.map((g) => (
          <div key={g.group}>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5">
              {g.group}
              <Badge variant="secondary" className="text-[10px] px-1.5">{g.items.length}</Badge>
            </p>
            <div className="space-y-1">
              {g.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={onClose}
                  className="block rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  <span className="break-all">{item.label}</span>
                  {item.sub && <span className="block mt-0.5 text-xs text-muted-foreground truncate">{item.sub}</span>}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
