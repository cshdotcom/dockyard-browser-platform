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
  children: React.ReactNode
}

export function AppShell({ user, menuGroups, unreadCount, maintenance, maintenanceMessage, children }: AppShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = React.useState(false)
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const [searchOpen, setSearchOpen] = React.useState(false)

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
                  <span className="hidden sm:inline text-xs">全局搜索（工作区/实例/用户）</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>全局搜索</DialogTitle>
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

  return (
    <DropdownMenu open={open} onOpenChange={(v) => { setOpen(v); if (v) void load() }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
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
                "block w-full text-left px-3 py-2.5 border-b last:border-0 transition",
                !n.readAt && "bg-teal-600/5",
                n.link ? "cursor-pointer hover:bg-muted/70" : "cursor-default",
              )}
              onClick={() => {
                if (n.link) {
                  setOpen(false)
                  router.push(n.link)
                }
              }}
            >
              <p className="text-sm font-medium leading-tight flex items-center gap-1.5">
                {n.type === "ANNOUNCEMENT" && <Megaphone className="h-3 w-3 text-violet-500 shrink-0" />}
                {n.title}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.content}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {new Date(n.createdAt).toLocaleString("zh-CN")}
                {n.link && <span className="ml-1 text-teal-600">点击查看 →</span>}
              </p>
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GlobalSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = React.useState("")
  const [results, setResults] = React.useState<{ group: string; items: { id: string; label: string; href: string }[] }[]>([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      setBusy(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`)
        const json = await res.json()
        if (json.code === 0) setResults(json.data.groups || [])
      } catch {
        toast.error("搜索失败")
      } finally {
        setBusy(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="space-y-3">
      <Input autoFocus placeholder="输入关键词：名称 / UUID / 用户名..." value={q} onChange={(e) => setQ(e.target.value)} />
      {busy && <p className="text-xs text-muted-foreground text-center py-4">搜索中...</p>}
      {!busy && results.length === 0 && q.trim().length >= 2 && <p className="text-xs text-muted-foreground text-center py-4">无匹配结果</p>}
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {results.map((g) => (
          <div key={g.group}>
            <p className="text-xs text-muted-foreground mb-1">{g.group}（{g.items.length}）</p>
            <div className="space-y-1">
              {g.items.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={onClose}
                  className="block rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
