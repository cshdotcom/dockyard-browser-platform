import Link from "next/link"
import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { StatCard } from "@/components/shared/confirm"
import { ProxyNodesTable, type ProxyNodeRow } from "./proxy-nodes-table"
import { BrowserNodesTable, type BrowserNodeRow } from "./browser-nodes-table"
import { HostNodesTable, type HostNodeRow } from "./host-nodes-table"
import { Network, Globe2, ShieldCheck, Server, MonitorCog, TriangleAlert, Boxes, Info } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

// 网络与节点（管理员）：代理节点 / 浏览器节点 / 宿主机 三页签
export const metadata = { title: "网络与节点" }

const TABS = [
  { key: "proxy", label: "代理节点" },
  { key: "browser", label: "浏览器节点" },
  { key: "host", label: "宿主机" },
] as const

export default async function AdminNetworkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const f = q.filters
  // 兼容历史 tab=steel 链接（Steel 声明移除后统一映射到 browser 页签）
  const rawTab = f.tab === "steel" ? "browser" : f.tab
  const tab = (TABS.find((t) => t.key === rawTab)?.key || "proxy") as "proxy" | "browser" | "host"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">网络与节点</h1>
        <p className="text-sm text-muted-foreground mt-1">
          出口代理、自研浏览器集群与宿主机资源的统一管控：健康探测 / 调度策略 / 灰度分组 / 水位告警
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/network?tab=${t.key}`}
            className={cn(
              "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-teal-600 text-teal-700 dark:text-teal-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "proxy" && <ProxyTab q={q} f={f} />}
      {tab === "browser" && <BrowserTab q={q} f={f} />}
      {tab === "host" && <HostTab q={q} f={f} />}
    </div>
  )
}

// ============================================================
// 代理节点页签
// ============================================================
async function ProxyTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ name: { contains: q.keyword } }, { host: { contains: q.keyword } }]
  }
  if (f.type) where.type = f.type
  if (f.status) where.status = f.status
  if (f.strategy) where.scheduleStrategy = f.strategy

  const [rows, total, statTotal, statHealthy, statFailed, statInternal] = await Promise.all([
    db.proxyNode.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "latencyMs", "weight"], { createdAt: "desc" }),
    }),
    db.proxyNode.count({ where }),
    db.proxyNode.count({ where: { deletedAt: null } }),
    db.proxyNode.count({ where: { deletedAt: null, status: "HEALTHY" } }),
    db.proxyNode.count({ where: { deletedAt: null, status: { in: ["FAILED", "DEGRADED"] } } }),
    db.proxyNode.count({ where: { deletedAt: null, type: "internal_singbox" } }),
  ])

  // internal_singbox 关联实例名（内存 join）
  const sbiIds = rows.map((r) => r.singboxInstanceId).filter(Boolean) as string[]
  const sbis = sbiIds.length ? await db.singboxInstance.findMany({ where: { id: { in: sbiIds } }, select: { id: true, name: true, status: true, socksAddr: true } }) : []
  const sbiById = new Map(sbis.map((s) => [s.id, s]))

  const list: ProxyNodeRow[] = rows.map((r) => {
    const sbi = r.singboxInstanceId ? sbiById.get(r.singboxInstanceId) : undefined
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      protocol: r.protocol,
      host: r.host,
      port: r.port,
      username: r.username,
      status: r.status,
      latencyMs: r.latencyMs,
      labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
      weight: r.weight,
      currentSessions: r.currentSessions,
      maxSessions: r.maxSessions,
      scheduleStrategy: r.scheduleStrategy,
      healthFailCount: r.healthFailCount,
      singboxInstanceId: r.singboxInstanceId,
      singboxName: sbi?.name || null,
      singboxStatus: sbi?.status || null,
      createdAt: fmtDate(r.createdAt),
    }
  })

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="总节点数" value={statTotal} sub="不含软删除" icon={<Network className="h-4 w-4" />} />
        <StatCard title="健康节点" value={statHealthy} sub="HEALTHY" icon={<ShieldCheck className="h-4 w-4" />} tone="success" />
        <StatCard title="故障/降级" value={statFailed} sub="FAILED + DEGRADED" icon={<TriangleAlert className="h-4 w-4" />} tone={statFailed > 0 ? "danger" : "default"} />
        <StatCard title="SingBox 内部出口" value={statInternal} sub="internal_singbox" icon={<Boxes className="h-4 w-4" />} />
      </div>
      <ProxyNodesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
      />
    </div>
  )
}

// ============================================================
// 浏览器节点页签
// ============================================================
async function BrowserTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ name: { contains: q.keyword } }, { baseUrl: { contains: q.keyword } }]
  }
  if (f.status) where.status = f.status
  if (f.grayGroup) where.grayGroup = f.grayGroup

  const [rows, total, statTotal, statOnline, statIsolated, statTest] = await Promise.all([
    db.browserNode.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "loadScore", "activeSessions"], { createdAt: "desc" }),
    }),
    db.browserNode.count({ where }),
    db.browserNode.count({ where: { deletedAt: null } }),
    db.browserNode.count({ where: { deletedAt: null, status: "ONLINE" } }),
    db.browserNode.count({ where: { deletedAt: null, status: "ISOLATED" } }),
    db.browserNode.count({ where: { deletedAt: null, grayGroup: "TEST" } }),
  ])

  const list: BrowserNodeRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    publicUrl: r.publicUrl || ENV.nodePublicUrl || null,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    weight: r.weight,
    status: r.status,
    grayGroup: r.grayGroup,
    activeSessions: r.activeSessions,
    loadScore: r.loadScore,
    probeFailCount: r.probeFailCount,
    enabled: r.enabled,
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="浏览器节点" value={statTotal} sub="浏览器执行集群" icon={<Globe2 className="h-4 w-4" />} />
        <StatCard title="在线" value={statOnline} sub="ONLINE" icon={<Server className="h-4 w-4" />} tone="success" />
        <StatCard title="已隔离" value={statIsolated} sub="连续探测失败≥3" icon={<TriangleAlert className="h-4 w-4" />} tone={statIsolated > 0 ? "danger" : "default"} />
        <StatCard title="灰度 TEST 组" value={statTest} sub="PROD/TEST 分组" icon={<MonitorCog className="h-4 w-4" />} />
      </div>

      <div className="rounded-lg border border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20 p-4 flex gap-3">
        <Info className="h-4 w-4 text-teal-600 shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">浏览器节点服务仅内网访问。</span>
          所有会话创建/销毁/探测请求均由本平台后端中转发起，前端与外部网络无法直达浏览器集群；节点连续 3 次探测失败将自动隔离并停止调度新会话。
        </div>
      </div>

      {/* r28：节点公网地址环境推荐（NODE_PUBLIC_URL > PUBLIC_BASE_URL）—— 客户端表单读取 */}
      <span id="__nodePublicHint" hidden>{ENV.nodePublicUrl}</span>
      <BrowserNodesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
      />
    </div>
  )
}

// ============================================================
// 宿主机页签
// ============================================================
async function HostTab({ q, f }: { q: ReturnType<typeof parseListQuery>; f: Record<string, string> }) {
  const where: Record<string, unknown> = { deletedAt: null }
  if (q.keyword) {
    where.OR = [{ name: { contains: q.keyword } }, { dockerApiUrl: { contains: q.keyword } }]
  }
  if (f.grayGroup) where.grayGroup = f.grayGroup
  if (f.status) where.status = f.status

  const [rows, total, statTotal, statOnline, statHighWater] = await Promise.all([
    db.hostNode.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "cpuUsedPct", "diskUsedPct"], { createdAt: "desc" }),
    }),
    db.hostNode.count({ where }),
    db.hostNode.count({ where: { deletedAt: null } }),
    db.hostNode.count({ where: { deletedAt: null, status: "ONLINE", enabled: true } }),
    db.hostNode.count({ where: { deletedAt: null, OR: [{ cpuUsedPct: { gt: 80 } }, { diskUsedPct: { gt: 85 } }] } }),
  ])

  const list: HostNodeRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    dockerApiUrl: r.dockerApiUrl,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    cpuCores: r.cpuCores,
    memTotalMb: r.memTotalMb,
    cpuUsedPct: r.cpuUsedPct,
    memUsedMb: r.memUsedMb,
    diskUsedPct: r.diskUsedPct,
    reservedCpu: r.reservedCpu,
    reservedMemMb: r.reservedMemMb,
    grayGroup: r.grayGroup,
    status: r.status,
    enabled: r.enabled,
    createdAt: fmtDate(r.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="宿主机" value={statTotal} sub="Docker Engine 集群" icon={<Server className="h-4 w-4" />} />
        <StatCard title="在线可用" value={statOnline} sub="ONLINE 且启用" icon={<ShieldCheck className="h-4 w-4" />} tone="success" />
        <StatCard title="水位超限" value={statHighWater} sub="CPU>80% 或磁盘>85%" icon={<TriangleAlert className="h-4 w-4" />} tone={statHighWater > 0 ? "danger" : "success"} />
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">水位阈值</p>
            <Badge variant="outline" className="text-xs">CPU 80% / 磁盘 85%</Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">点击「采集资源」实时同步 CPU/内存/磁盘水位，超限自动告警</p>
        </div>
      </div>
      <HostNodesTable
        rows={list}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        filters={f}
      />
    </div>
  )
}
