import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { getAllConfig } from "@/lib/config"
import { fmtDate } from "@/lib/utils-server"
import { ConfigPanel, type ConfigItem, type ConfigVersionRow } from "./config-panel"
import { Settings } from "lucide-react"

// 系统配置（管理员可查看，仅超级管理员可修改）——配置项随时后台可改，禁用路由缓存保证回显最新落库值
export const dynamic = "force-dynamic"

export const metadata = { title: "系统配置" }

export default async function AdminConfigPage() {
  const ctx = await requireAdmin()

  // 全量配置 + 最近版本历史（300条），一次性下发客户端 Tabs
  const [items, versions] = await Promise.all([
    getAllConfig(),
    db.configVersion.findMany({ orderBy: { createdAt: "desc" }, take: 300 }),
  ])

  // 操作人名（内存 join）
  const operatorIds = [...new Set(versions.map((v) => v.operatorUserId).filter((v): v is string => !!v))]
  const operators = operatorIds.length
    ? await db.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, username: true, displayName: true } })
    : []
  const operatorMap = new Map(operators.map((o) => [o.id, o.displayName || o.username]))
  const currentVersionMap = new Map(items.map((i) => [i.key, i.version]))

  const configItems: ConfigItem[] = items.map((i) => ({
    key: i.key,
    value: i.value,
    type: i.type,
    category: i.category,
    description: i.description,
    version: i.version,
  }))

  const versionRows: ConfigVersionRow[] = versions.map((v) => ({
    id: v.id,
    configKey: v.configKey,
    version: v.version,
    before: v.beforeJson ? JSON.parse(v.beforeJson) : null,
    after: v.afterJson ? JSON.parse(v.afterJson) : null,
    operator: v.operatorUserId ? operatorMap.get(v.operatorUserId) || v.operatorUserId : "系统",
    createdAt: fmtDate(v.createdAt),
    currentVersion: currentVersionMap.get(v.configKey) ?? 0,
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">系统配置</h1>
          <p className="text-sm text-muted-foreground mt-1">
            全平台运行参数中心：安全 / 会话 / 存储 / 告警 / 网络 / UI / 通用 / MCP，全部变更留版本快照可回滚
            {ctx.role !== "SUPER_ADMIN" && <span className="ml-1 text-amber-600">（当前为管理员视角：只读）</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Settings className="h-4 w-4" />
          共 {configItems.length} 项配置
        </div>
      </div>

      <ConfigPanel items={configItems} versions={versionRows} canEdit={ctx.role === "SUPER_ADMIN"} />
    </div>
  )
}
