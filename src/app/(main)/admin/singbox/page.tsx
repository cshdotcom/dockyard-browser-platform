import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { parseListQuery, pageSkipTake, safeOrderBy, fmtDate } from "@/lib/utils-server"
import { SingboxManager } from "./singbox-manager"

export const metadata = { title: "SingBox 实例编排" }

export default async function SingboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)

  const where = {
    deletedAt: null,
    ...(q.filters.status ? { status: q.filters.status } : {}),
    ...(q.keyword ? { OR: [{ name: { contains: q.keyword } }, { remark: { contains: q.keyword } }] } : {}),
  }

  const [instances, total, hosts, stats] = await Promise.all([
    db.singboxInstance.findMany({
      where,
      ...pageSkipTake(q),
      orderBy: safeOrderBy(q, ["createdAt", "name", "status", "currentSessions"], { createdAt: "desc" }) as Record<string, "asc" | "desc">,
    }),
    db.singboxInstance.count({ where }),
    db.hostNode.findMany({ where: { deletedAt: null, enabled: true }, select: { id: true, name: true, status: true, cpuCores: true, memTotalMb: true, reservedCpu: true, reservedMemMb: true } }),
    Promise.all([
      db.singboxInstance.count({ where: { deletedAt: null, status: "RUNNING" } }),
      db.singboxInstance.count({ where: { deletedAt: null, status: { in: ["ERROR", "STOPPED"] } } }),
      db.proxyNode.count({ where: { type: "internal_singbox", deletedAt: null } }),
    ]),
  ])

  const data = instances.map((i) => ({
    id: i.id,
    name: i.name,
    remark: i.remark ?? "",
    tags: (i.tags as string[]) || [],
    status: i.status,
    cpuLimit: i.cpuLimit,
    memLimitMb: i.memLimitMb,
    maxSessions: i.maxSessions,
    currentSessions: i.currentSessions,
    hostNodeId: i.hostNodeId,
    socksAddr: i.socksAddr,
    configVersion: i.configVersion,
    autoRestart: i.autoRestart,
    trafficLimitMb: i.trafficLimitMb,
    bytesUpMb: i.bytesUpMb,
    bytesDownMb: i.bytesDownMb,
    peakTrafficMb: i.peakTrafficMb,
    overLimitAction: i.overLimitAction,
    containerId: i.containerId,
    lastError: i.lastError,
    ownerUserId: i.ownerUserId,
    createdByUserId: i.createdByUserId,
    createdAt: fmtDate(i.createdAt),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sing-Box 实例编排</h1>
        <p className="text-sm text-muted-foreground mt-1">
          可视化创建内置 Sing-Box 代理容器：配置经内存组装注入容器环境变量（不落盘）· Docker API 直接编排 · 状态自动同步代理池
        </p>
      </div>
      <SingboxManager
        instances={data}
        total={total}
        page={q.page}
        pageSize={q.pageSize}
        keyword={q.keyword}
        sortField={q.sortField}
        sortOrder={q.sortOrder}
        hosts={hosts.map((h) => ({
          id: h.id, name: h.name, status: h.status,
          cpuAvailable: Math.round((h.cpuCores - h.reservedCpu) * 1000) / 1000,
          memAvailableMb: Math.round((h.memTotalMb - h.reservedMemMb) * 1000) / 1000,
        }))}
        runningCount={stats[0]}
        abnormalCount={stats[1]}
        proxyCount={stats[2]}
      />
    </div>
  )
}
