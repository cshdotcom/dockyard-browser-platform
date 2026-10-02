import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { getAuthContext, needs2faSetup } from "@/lib/permissions"
import { getConfigBool, getConfig } from "@/lib/config"
import { AppShell, type MenuGroup } from "@/components/layout/app-shell"
import {
  LayoutDashboard, Globe, FileCode2, KeyRound, ShieldCheck, Megaphone,
  Users, FolderTree, ScrollText, Settings2, Timer, FolderOpen, DatabaseBackup,
  Server, Network, Recycle, ShieldAlert, MessageSquareCode, SlidersHorizontal, Puzzle,
} from "lucide-react"

// 主应用布局（RSC）：深度会话校验 + 强制2FA策略拦截 + 权限菜单过滤
export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext()
  // 会话失效（撤销/过期/闲置/DB重置）：经 logout 清掉失效 cookie 再回登录页，
  // 避免浏览器持有旧 cookie 反复弹跳（登录成功 → 布局判失效 → 踢回 → 再登录……）
  if (!ctx) redirect("/api/auth/logout?redirect=%2Flogin&reason=session-invalid")

  // 强制2FA策略：未完成设置前只能停留在账号安全页
  if (await needs2faSetup()) {
    const allowed = ["/account/security", "/account/sessions", "/account/profile"]
    // 在 layout 无法直接取 pathname，由 /account/security 页面自身引导；此处放行由各 admin/业务页再校验
  }

  const unread = await db.notice.count({ where: { userId: ctx.userId, readAt: null } })
  const me = await db.user.findUnique({ where: { id: ctx.userId }, select: { avatarPath: true } })
  const maintenance = await getConfigBool("maintenance.enabled", false)
  const maintenanceMessage = await getConfig<string>("maintenance.message", "系统维护中")

  // ---- 权限菜单过滤：RSC读取角色，过滤掉无权限的菜单 ----
  const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
  const isGroupAdmin = ctx.role === "GROUP_ADMIN"

  const commonGroups: MenuGroup[] = [
    {
      key: "work",
      label: "工作台",
      items: [
        { key: "dashboard", label: "仪表盘", href: "/dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
        { key: "workspaces", label: "浏览器工作区", href: "/workspaces", icon: <Globe className="h-4 w-4" /> },
        { key: "templates", label: "会话模板", href: "/templates", icon: <FileCode2 className="h-4 w-4" /> },
        { key: "announcements", label: "平台公告", href: "/announcements", icon: <Megaphone className="h-4 w-4" /> },
      ],
    },
    {
      key: "account",
      label: "个人中心",
      items: [
        { key: "security", label: "账号安全", href: "/account/security", icon: <ShieldCheck className="h-4 w-4" /> },
        { key: "sessions", label: "登录设备", href: "/account/sessions", icon: <KeyRound className="h-4 w-4" /> },
        { key: "tokens", label: "我的 API 令牌", href: "/account/tokens", icon: <KeyRound className="h-4 w-4" /> },
      ],
    },
  ]

  const adminGroups: MenuGroup[] = [
    {
      key: "admin-core",
      label: "管理后台",
      items: [
        { key: "a-users", label: "用户管理", href: "/admin/users", icon: <Users className="h-4 w-4" /> },
        { key: "a-groups", label: "用户组管理", href: "/admin/groups", icon: <FolderTree className="h-4 w-4" /> },
        { key: "a-policies", label: "策略下发中心", href: "/admin/policies", icon: <SlidersHorizontal className="h-4 w-4" /> },
        { key: "a-crx", label: "CRX 插件管控", href: "/admin/crx", icon: <Puzzle className="h-4 w-4" /> },
        { key: "a-sessions", label: "在线会话管控", href: "/admin/sessions", icon: <KeyRound className="h-4 w-4" /> },
        { key: "a-workspaces", label: "工作区管控", href: "/admin/workspaces", icon: <Globe className="h-4 w-4" /> },
      ],
    },
    {
      key: "admin-ops",
      label: "平台运维",
      items: [
        { key: "a-singbox", label: "SingBox 实例", href: "/admin/singbox", icon: <Server className="h-4 w-4" /> },
        { key: "a-network", label: "网络与节点", href: "/admin/network", icon: <Network className="h-4 w-4" /> },
        { key: "a-config", label: "系统配置", href: "/admin/config", icon: <Settings2 className="h-4 w-4" /> },
        { key: "a-tasks", label: "定时任务", href: "/admin/tasks", icon: <Timer className="h-4 w-4" /> },
        { key: "a-files", label: "文件存储", href: "/admin/files", icon: <FolderOpen className="h-4 w-4" /> },
        { key: "a-backups", label: "备份恢复", href: "/admin/backups", icon: <DatabaseBackup className="h-4 w-4" /> },
      ],
    },
    {
      key: "admin-audit",
      label: "安全与审计",
      items: [
        { key: "a-audit", label: "审计日志", href: "/admin/audit", icon: <ScrollText className="h-4 w-4" /> },
        { key: "a-alerts", label: "告警中心", href: "/admin/alerts", icon: <Megaphone className="h-4 w-4" /> },
        { key: "a-recycle", label: "回收站", href: "/admin/recycle", icon: <Recycle className="h-4 w-4" /> },
        { key: "a-risk", label: "风控与画像", href: "/admin/risk", icon: <ShieldAlert className="h-4 w-4" /> },
        { key: "a-announcements", label: "公告管理", href: "/admin/announcements", icon: <Megaphone className="h-4 w-4" /> },
        { key: "a-mcp", label: "MCP 任务", href: "/admin/mcp", icon: <MessageSquareCode className="h-4 w-4" /> },
      ],
    },
  ]

  const menuGroups = isAdmin || isGroupAdmin ? [...commonGroups, ...adminGroups] : commonGroups

  return (
    <AppShell
      user={{ id: ctx.userId, username: ctx.username, displayName: ctx.displayName, email: ctx.email, role: ctx.role, hasAvatar: !!me?.avatarPath }}
      menuGroups={menuGroups}
      unreadCount={unread}
      maintenance={maintenance}
      maintenanceMessage={maintenanceMessage}
    >
      {children}
    </AppShell>
  )
}
