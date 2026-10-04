"use client"

// ============================================================
// r29-f：分布式文件存储面板（对象清单 + 节点分布 + 维护触发）
// r31 增强：
//   · 节点多选筛选（可搜索；全部/单节点/多节点文件查看）
//   · 归属列完整显示（绑定类型 + 用户/沙箱/组可读名）
//   · 点击归属徽章 → 自动筛选该归属（所有带归属显示的统一交互）
//   · 点击落点节点徽章 → 自动纳入该节点筛选
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Database, Snowflake, RefreshCw, HardDriveDownload, Network, X } from "lucide-react"
import { MultiSelectPopover } from "@/components/shared/multi-select-popover"
import { listFileObjectsAction, dfsStatsAction, triggerDfsMaintenanceAction } from "@/server/actions/dfs-actions"

interface FileRow {
  id: string; fileKey: string; name: string; sizeMb: number; bindType: string; bindId: string | null
  bindLabel: string; tier: string; replicas: number; uploadChannel: string; relayed: boolean
  lastAccessAt: string; placements: Array<{ nodeUuid: string; role: string; status: string }>
}

const BIND_LABEL: Record<string, string> = { SANDBOX: "沙箱绑定", USER: "用户空间", SHARE: "共享协作", GENERAL: "常规" }
const CHANNEL_LABEL: Record<string, string> = { MASTER_RELAY: "主控中转", DIRECT_WORKER: "直沉 Worker" }

export function DfsPanel() {
  const [files, setFiles] = React.useState<FileRow[]>([])
  const [nodes, setNodes] = React.useState<Array<{ nodeUuid: string; name: string; online: boolean }>>([])
  const [stats, setStats] = React.useState<{ totalFiles: number; totalMb: number; relayPending: number; coldFiles: number; lostPlacements: number; byChannel: { relay: number; direct: number }; nodeSpread: Array<{ nodeUuid: string; files: number }> } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [bindFilter, setBindFilter] = React.useState("")
  const [tierFilter, setTierFilter] = React.useState("")
  const [keyword, setKeyword] = React.useState("")
  // r31：节点多选筛选 + 归属精确筛选
  const [nodeSel, setNodeSel] = React.useState<string[]>([])
  const [bindIdFilter, setBindIdFilter] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    setLoading(true)
    const [list, st] = await Promise.all([
      listFileObjectsAction({
        ...(bindFilter ? { bindType: bindFilter } : {}),
        ...(tierFilter ? { tier: tierFilter } : {}),
        ...(keyword ? { keyword } : {}),
        ...(nodeSel.length > 0 ? { nodeUuids: nodeSel } : {}),
        ...(bindIdFilter ? { bindId: bindIdFilter } : {}),
        take: 100,
      }),
      dfsStatsAction(),
    ])
    if (list.code === 0 && list.data) {
      setFiles(list.data.files)
      setNodes(list.data.nodes)
    }
    if (st.code === 0 && st.data) setStats(st.data)
    setLoading(false)
  }, [bindFilter, tierFilter, keyword, nodeSel, bindIdFilter])

  React.useEffect(() => { void refresh() }, [refresh])

  const runMaintenance = async () => {
    setBusy("maint")
    try {
      const res = await triggerDfsMaintenanceAction()
      if (res.code === 0) {
        toast.success(`维护完成：中转下沉 ${res.data?.relayExpired || 0}、副本失联 ${res.data?.lostMarked || 0}（重建 ${res.data?.repairsPlanned || 0}）、冷分层 ${res.data?.tiered || 0}`)
        void refresh()
      } else toast.error(res.msg || "维护失败")
    } finally { setBusy(null) }
  }

  // r31：点击归属 → 精确筛选（切换语义：再次点击取消）
  const clickBind = (bindId: string | null) => {
    if (!bindId) return
    setBindIdFilter((cur) => (cur === bindId ? null : bindId))
  }

  const nodeOptions = React.useMemo(
    () => nodes.map((n) => ({
      id: n.nodeUuid,
      label: `${n.name}（${n.nodeUuid.slice(0, 10)}）`,
      sub: (stats?.nodeSpread.find((s) => s.nodeUuid === n.nodeUuid)?.files ?? 0) + " 文件",
      dot: n.online ? "bg-emerald-500" : "bg-slate-400",
    })),
    [nodes, stats],
  )

  return (
    <div className="space-y-4">
      {/* 统计卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Database className="h-3.5 w-3.5" /> 对象总数</div>
          <div className="text-2xl font-semibold">{stats?.totalFiles ?? "-"}</div>
          <div className="text-[10px] text-muted-foreground">{stats?.totalMb ?? 0} MB 总量</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><HardDriveDownload className="h-3.5 w-3.5" /> 主控中转待下沉</div>
          <div className="text-2xl font-semibold text-amber-600">{stats?.relayPending ?? "-"}</div>
          <div className="text-[10px] text-muted-foreground">通道分布：中转 {stats?.byChannel.relay ?? 0} / 直沉 {stats?.byChannel.direct ?? 0}</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Snowflake className="h-3.5 w-3.5" /> 冷层归档</div>
          <div className="text-2xl font-semibold text-sky-600">{stats?.coldFiles ?? "-"}</div>
          <div className="text-[10px] text-muted-foreground">30 天未访问 → COLD</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Network className="h-3.5 w-3.5" /> 节点分布</div>
          <div className="text-2xl font-semibold">{stats?.nodeSpread.length ?? "-"}</div>
          <div className="text-[10px] text-muted-foreground truncate">{(stats?.nodeSpread || []).slice(0, 3).map((n) => `${n.nodeUuid}:${n.files}`).join(" · ") || "无活跃落点"}</div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> 副本失联</div>
          <div className={`text-2xl font-semibold ${stats?.lostPlacements ? "text-red-600" : ""}`}>{stats?.lostPlacements ?? "-"}</div>
          <Button size="sm" variant="secondary" className="mt-1 h-7 text-xs w-full" disabled={busy === "maint"} onClick={() => void runMaintenance()}>
            {busy === "maint" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}立即维护
          </Button>
        </CardContent></Card>
      </div>

      {/* 筛选条（r31：节点多选 + 归属筛选激活提示） */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索文件名/fileKey" className="h-8 w-44 rounded-md border bg-background px-2 text-sm" />
        {["", "SANDBOX", "USER", "SHARE", "GENERAL"].map((b) => (
          <button key={b || "all"} onClick={() => setBindFilter(b)}
            className={`h-7 px-2 rounded-md border text-xs ${bindFilter === b ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>
            {b ? BIND_LABEL[b] : "全部绑定"}
          </button>
        ))}
        {["", "HOT", "COLD"].map((t) => (
          <button key={t || "alltier"} onClick={() => setTierFilter(t)}
            className={`h-7 px-2 rounded-md border text-xs ${tierFilter === t ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}>
            {t ? (t === "HOT" ? "热层" : "冷层") : "全部层"}
          </button>
        ))}
        {/* r31：节点多选筛选（可搜索；= 全部/单个/多个节点文件） */}
        <MultiSelectPopover
          options={nodeOptions}
          selected={nodeSel}
          onChange={setNodeSel}
          placeholder="全部节点"
          searchPlaceholder="搜索节点名/UUID…"
          width={320}
        />
        {bindIdFilter && (
          <button onClick={() => setBindIdFilter(null)} className="inline-flex h-7 items-center gap-1 rounded-md border border-teal-300 bg-teal-50 px-2 text-xs text-teal-700" title="取消归属筛选">
            归属：{files.find((f) => f.bindId === bindIdFilter)?.bindLabel || bindIdFilter.slice(0, 12)}
            <X className="h-3 w-3" />
          </button>
        )}
        <Button size="sm" variant="outline" className="h-7" onClick={() => { setLoading(true); void refresh() }}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>

      {/* 对象表 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">文件对象 · 落点分布 · 归属</CardTitle>
          <CardDescription>
            9 大条件路由：沙箱绑定强制落地（最高优先级）/ ≥10MB 直沉 Worker（小文件主控中转 24h）/ 共享下沉被访问端 / 冷热分层 30 天 / 20% 安全水位 / 多副本 1-3 / 副本修复 / 迁移随迁 / 中转超时下沉
            。r31：点击归属或落点徽章可自动筛选对应维度。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 装载中…</div>
          ) : files.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {nodeSel.length > 0 || bindIdFilter ? "当前筛选条件下暂无文件对象" : "暂无文件对象（上传/业务落盘后按 9 条件路由登记）"}
            </div>
          ) : (
            <div className="divide-y rounded-lg border overflow-x-auto">
              {files.map((f) => (
                <div key={f.id} className="px-3 py-2.5 grid grid-cols-1 lg:grid-cols-[2fr_1.2fr_1fr_1fr_1.4fr] items-center gap-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={f.name}>{f.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">{f.fileKey}</div>
                  </div>
                  {/* r31：归属列（可读名 + 点击筛选） */}
                  <div className="flex flex-wrap items-center gap-1 min-w-0">
                    <Badge variant="outline" className="text-[10px] px-1 py-0">{BIND_LABEL[f.bindType] || f.bindType}</Badge>
                    {f.bindLabel && (
                      <button
                        type="button"
                        onClick={() => clickBind(f.bindId)}
                        title={`归属：${f.bindLabel}（点击${bindIdFilter === f.bindId ? "取消" : ""}筛选）`}
                        className={`inline-flex max-w-32 truncate rounded px-1.5 py-0 text-[10px] border transition-colors ${bindIdFilter === f.bindId ? "border-teal-400 bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300" : "border-slate-200 bg-slate-50 text-slate-600 hover:border-teal-300 hover:text-teal-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"}`}
                      >
                        {f.bindLabel}
                      </button>
                    )}
                    <Badge variant={f.tier === "COLD" ? "secondary" : "default"} className="text-[10px] px-1 py-0">{f.tier === "COLD" ? "冷层" : "热层"}</Badge>
                  </div>
                  <div className="text-xs">
                    <div className={f.uploadChannel === "DIRECT_WORKER" ? "text-teal-600" : "text-amber-600"}>{CHANNEL_LABEL[f.uploadChannel]}</div>
                    {f.uploadChannel === "MASTER_RELAY" && (
                      <div className="text-[10px] text-muted-foreground">{f.relayed ? "已下沉" : "待下沉（24h TTL）"}</div>
                    )}
                  </div>
                  <div className="text-xs">
                    <div>{f.sizeMb} MB · {f.replicas} 副本</div>
                    <div className="text-[10px] text-muted-foreground">{new Date(f.lastAccessAt).toLocaleString("zh-CN")}</div>
                  </div>
                  {/* 落点徽章（r31：点击纳入该节点筛选） */}
                  <div className="flex flex-wrap gap-1">
                    {f.placements.map((pl) => (
                      <button
                        key={`${pl.nodeUuid}-${pl.role}`}
                        type="button"
                        onClick={() => setNodeSel((cur) => (cur.includes(pl.nodeUuid) ? cur : [...cur, pl.nodeUuid]))}
                        title={`${pl.nodeUuid} ${pl.role} ${pl.status}（点击筛选该节点）`}
                        className={`rounded text-[10px] px-1 py-0 border ${
                          pl.status === "LOST"
                            ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                            : pl.status === "ACTIVE"
                              ? "border-slate-200 bg-slate-100 text-slate-700 hover:border-teal-300 hover:text-teal-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                              : "border-slate-200 bg-muted text-muted-foreground"
                        }`}
                      >
                        {pl.nodeUuid.slice(0, 10)}·{pl.role === "PRIMARY" ? "主" : "副"}{pl.status !== "ACTIVE" ? `·${pl.status}` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
