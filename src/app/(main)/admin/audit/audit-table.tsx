"use client"

// 审计日志 + 安全事件 双页签交互组件：筛选 / 详情弹窗（before/after JSON diff）/ CSV导出 / 只读

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { FileDown, Eye, Undo2, Loader2, ShieldCheck } from "lucide-react"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { rollbackAuditAction } from "@/server/actions/audit-rollback"
import { UnifiedFilterBar } from "@/components/shared/filter-bar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"

export interface AuditRow {
  id: string
  traceId: string | null
  operatorUserId: string | null
  operatorName: string | null
  operationType: string
  resourceType: string
  resourceId: string | null
  resourceName: string | null
  ownerUserId: string | null
  createdByUserId: string | null
  clientIp: string | null
  severity: string
  beforeJson: string | null
  afterJson: string | null
  extraJson: string | null
  createdAt: string
}

export interface SecurityRow {
  id: string
  userId: string | null
  username: string | null
  eventType: string
  success: boolean
  ip: string | null
  userAgent: string | null
  detail: string | null
  traceId: string | null
  createdAt: string
}

interface AuditTableProps {
  tab: "audit" | "security"
  auditRows?: AuditRow[]
  securityRows?: SecurityRow[]
  total: number
  page: number
  pageSize: number
  keyword?: string
  sortField?: string
  sortOrder?: "asc" | "desc"
  filters: Record<string, string>
  mine?: boolean // 普通用户模式：仅自己的记录（隐藏操作人筛选，提示隔离说明）
  showRollback?: boolean // 管理员：详情弹窗展示一键回滚按钮
}

// ---- JSON diff 视图 ----

function parseObj(s?: string | null): Record<string, unknown> | null {
  if (!s) return null
  try {
    const v: unknown = JSON.parse(s)
    if (v === null || v === undefined) return null
    if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
    return { value: v }
  } catch {
    return { _parseError: s }
  }
}

function stableStr(v: unknown): string {
  if (v === undefined) return "undefined"
  try {
    return JSON.stringify(v, null, 2) ?? "null"
  } catch {
    return String(v)
  }
}

function DiffView({ beforeStr, afterStr }: { beforeStr: string | null; afterStr: string | null }) {
  const before = parseObj(beforeStr)
  const after = parseObj(afterStr)
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]))

  if (!before && !after) {
    return <p className="py-6 text-center text-sm text-muted-foreground">该记录无 before / after 快照</p>
  }

  const toneOf = (k: string): { cls: string; label: string } => {
    const inBefore = before ? k in before : false
    const inAfter = after ? k in after : false
    if (inBefore && !inAfter) return { cls: "bg-red-500/10 border-red-500/40", label: "删除" }
    if (!inBefore && inAfter) return { cls: "bg-emerald-500/10 border-emerald-500/40", label: "新增" }
    const changed = stableStr(before![k]) !== stableStr(after![k])
    return changed
      ? { cls: "bg-amber-500/10 border-amber-500/40", label: "变更" }
      : { cls: "bg-muted/40", label: "不变" }
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[7rem_1fr_1fr] gap-2 text-xs font-medium text-muted-foreground px-1">
        <span>字段 / 状态</span>
        <span>变更前（before）</span>
        <span>变更后（after）</span>
      </div>
      {keys.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">空对象</p>}
      {keys.map((k) => {
        const tone = toneOf(k)
        return (
          <div key={k} className="grid grid-cols-[7rem_1fr_1fr] gap-2 items-stretch">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-xs font-semibold break-all">{k}</span>
              <Badge
                variant="outline"
                className={
                  tone.label === "删除" ? "border-red-500/50 text-red-600" :
                  tone.label === "新增" ? "border-emerald-500/50 text-emerald-600" :
                  tone.label === "变更" ? "border-amber-500/50 text-amber-600" : ""
                }
              >
                {tone.label}
              </Badge>
            </div>
            <pre className={`rounded-md border p-2 text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto ${tone.cls}`}>
              {before && k in before ? stableStr(before[k]) : "—"}
            </pre>
            <pre className={`rounded-md border p-2 text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto ${tone.cls}`}>
              {after && k in after ? stableStr(after[k]) : "—"}
            </pre>
          </div>
        )
      })}
    </div>
  )
}

// 可回滚操作类型清单（与 audit-rollback.ts 的 RULES 对应；用于前端判断按钮显隐）
const ROLLBACKABLE = new Set([
  "ANNOUNCEMENT_TOGGLE", "ANNOUNCEMENT_BATCH_TOGGLE",
  "TASK_TOGGLE", "TASK_BATCH_TOGGLE",
  "TOKEN_TOGGLE", "TOKEN_ADMIN_TOGGLE",
  "ALERT_RULE_TOGGLE", "ALERT_RULE_BATCH_TOGGLE",
  "WEBHOOK_TOGGLE", "WEBHOOK_RULE_BATCH_TOGGLE",
  "CRX_PLUGIN_TOGGLE", "CRX_PLUGIN_BATCH_TOGGLE",
  "USER_FORCE_2FA", "USER_UPDATE", "USER_BATCH_STATUS",
  "GROUP_UPDATE",
])

export function AuditTable({ tab, auditRows = [], securityRows = [], total, page, pageSize, keyword, sortField, sortOrder, filters, mine, showRollback }: AuditTableProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [detail, setDetail] = React.useState<AuditRow | null>(null)
  const [secDetail, setSecDetail] = React.useState<SecurityRow | null>(null)
  // 回滚状态：仅管理员 + 可回滚操作类型（布尔态/策略/配额类）
  const [rolling, setRolling] = React.useState(false)
  const detailRollable = !!showRollback && !!detail && ROLLBACKABLE.has(detail.operationType) && !!detail.beforeJson

  const doRollback = async () => {
    if (!detail) return
    setRolling(true)
    try {
      const res = await rollbackAuditAction({ auditId: detail.id })
      if (res.code === 0) {
        const n = res.data?.restored?.length ?? 0
        const skipped = res.data?.skipped?.length ?? 0
        toast.success(`回滚完成：已恢复 ${n} 个资源${skppedNote(skipped)}`)
        setDetail(null)
        router.refresh()
      } else {
        toast.error(res.msg)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "回滚失败")
    } finally {
      setRolling(false)
    }
  }
  const skppedNote = (n: number) => (n > 0 ? `，${n} 个跳过（详情见 toast/审计）` : "")

  const pushQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") params.delete(k)
      else params.set(k, v)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  // ---- 审计日志列 ----
  const auditColumns = [
    { key: "createdAt", title: "时间", sortable: true, render: (row: AuditRow) => <span className="text-xs whitespace-nowrap">{row.createdAt}</span> },
    { key: "operatorName", title: "操作人", render: (row: AuditRow) => (
      <div className="min-w-0">
        <p className="text-sm truncate">{row.operatorName || "系统"}</p>
        {row.clientIp && <p className="text-[10px] text-muted-foreground font-mono">{row.clientIp}</p>}
      </div>
    ) },
    { key: "operationType", title: "操作类型", sortable: true, render: (row: AuditRow) => <Badge variant="secondary" className="text-[11px] font-mono">{row.operationType}</Badge> },
    {
      key: "resourceType",
      title: "资源",
      sortable: true,
      render: (row: AuditRow) => (
        <div className="min-w-0">
          <p className="text-sm truncate">{row.resourceType}{row.resourceName ? ` · ${row.resourceName}` : ""}</p>
          {row.resourceId && (
            <p className="text-[10px] text-muted-foreground font-mono truncate max-w-40" title={row.resourceId}>{row.resourceId}</p>
          )}
        </div>
      ),
    },
    { key: "severity", title: "级别", sortable: true, render: (row: AuditRow) => <StatusBadge status={row.severity} /> },
    { key: "traceId", title: "TraceID", render: (row: AuditRow) => (
      <span className="text-[10px] font-mono text-muted-foreground">{row.traceId ? row.traceId.slice(0, 8) : "-"}</span>
    ) },
  ]

  // ---- 安全事件列 ----
  const securityColumns = [
    { key: "createdAt", title: "时间", sortable: true, render: (row: SecurityRow) => <span className="text-xs whitespace-nowrap">{row.createdAt}</span> },
    { key: "username", title: "用户", render: (row: SecurityRow) => <span className="text-sm truncate">{row.username || row.userId?.slice(0, 8) || "-"}</span> },
    { key: "eventType", title: "事件类型", sortable: true, render: (row: SecurityRow) => <Badge variant="secondary" className="text-[11px] font-mono">{row.eventType}</Badge> },
    { key: "success", title: "结果", render: (row: SecurityRow) => <StatusBadge status={row.success ? "SUCCESS" : "FAILED"} /> },
    { key: "ip", title: "IP", render: (row: SecurityRow) => <span className="text-xs font-mono">{row.ip || "-"}</span> },
    { key: "detail", title: "详情", render: (row: SecurityRow) => <span className="text-xs text-muted-foreground truncate block max-w-64" title={row.detail || ""}>{row.detail || "-"}</span> },
  ]

  // ---- CSV 导出（审计页签） ----
  const exportCsv = () => {
    const params = new URLSearchParams()
    if (filters.from) params.set("from", filters.from)
    if (filters.to) params.set("to", filters.to)
    if (filters.resourceId) params.set("resourceId", filters.resourceId)
    if (filters.operator) params.set("operator", filters.operator)
    const qs = params.toString()
    window.open(`/api/export/audit${qs ? `?${qs}` : ""}`, "_blank")
  }

  const isAudit = tab === "audit"

  return (
    <div className="space-y-4">
      {/* 页签切换 */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onValueChange={(v) => pushQuery({ tab: v, page: "1" })}>
          <TabsList>
            <TabsTrigger value="audit">审计日志</TabsTrigger>
            <TabsTrigger value="security">安全事件</TabsTrigger>
          </TabsList>
        </Tabs>
        {isAudit && (
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <FileDown className="mr-1 h-4 w-4" /> 导出CSV（当前筛选）
          </Button>
        )}
      </div>

      {/* 统一筛选搜索栏：关键词 + 搜索类型筛选 + 时间范围快捷预设 */}
      <UnifiedFilterBar
        keyword={keyword}
        filters={filters}
        keywordPlaceholder={isAudit ? "搜索操作人/资源/操作类型/TraceID…（回车提交）" : "搜索用户/事件类型/详情/IP…（回车提交）"}
        selectDefs={isAudit ? [
          { key: "severity", label: "级别", options: [
            { label: "INFO", value: "INFO" }, { label: "WARN", value: "WARN" },
            { label: "CRITICAL", value: "CRITICAL" }, { label: "DANGER", value: "DANGER" },
          ] },
          { key: "resourceType", label: "资源类型", options: [
            { label: "用户", value: "USER" }, { label: "用户组", value: "GROUP" }, { label: "工作区", value: "WORKSPACE" },
            { label: "配置", value: "CONFIG" }, { label: "审计记录", value: "AUDIT" }, { label: "文件", value: "FILE" }, { label: "网络策略", value: "NETWORK" },
            { label: "CRX 插件", value: "CRX_PLUGIN" }, { label: "模板", value: "TEMPLATE" }, { label: "令牌", value: "API_TOKEN" },
            { label: "会话", value: "LOGIN_SESSION" }, { label: "代理节点", value: "PROXY_NODE" },
            { label: "VNC 录像", value: "RECORDING" },
          ] },
        ] : [
          { key: "success", label: "结果", options: [{ label: "成功", value: "true" }, { label: "失败", value: "false" }] },
        ]}
      />

      {/* 专项筛选区（字段级精确过滤，配合统一筛选栏；普通用户模式隐藏操作人筛选） */}
      <div className="rounded-lg border bg-card p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {isAudit ? (
          <>
            {!mine && (
              <div className="space-y-1">
                <Label className="text-xs">操作人</Label>
                <Input
                  defaultValue={filters.operator || ""}
                  placeholder="操作人名称包含..."
                  className="h-8"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") pushQuery({ operator: (e.target as HTMLInputElement).value, page: "1" })
                  }}
                  onBlur={(e) => {
                    if ((filters.operator || "") !== e.target.value) pushQuery({ operator: e.target.value, page: "1" })
                  }}
                />
              </div>
            )}
            {mine && (
              <div className="space-y-1 sm:col-span-2 lg:col-span-4 flex items-center gap-2 rounded-md border border-teal-200 bg-teal-50/60 dark:bg-teal-950/30 dark:border-teal-800 px-3 py-2">
                <ShieldCheck className="h-4 w-4 text-teal-600 shrink-0" />
                <p className="text-xs text-teal-700 dark:text-teal-300">仅显示你自己的操作记录：数据面在服务端按账号隔离，任何筛选都无法查看他人记录</p>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">操作类型</Label>
              <Input
                defaultValue={filters.operationType || ""}
                placeholder="如 USER_CREATE"
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter") pushQuery({ operationType: (e.target as HTMLInputElement).value, page: "1" })
                }}
                onBlur={(e) => {
                  if ((filters.operationType || "") !== e.target.value) pushQuery({ operationType: e.target.value, page: "1" })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">资源类型</Label>
              <Input
                defaultValue={filters.resourceType || ""}
                placeholder="如 USER / GROUP"
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter") pushQuery({ resourceType: (e.target as HTMLInputElement).value, page: "1" })
                }}
                onBlur={(e) => {
                  if ((filters.resourceType || "") !== e.target.value) pushQuery({ resourceType: e.target.value, page: "1" })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">资源ID（追踪完整链路）</Label>
              <Input
                defaultValue={filters.resourceId || ""}
                placeholder="粘贴资源ID过滤"
                className="h-8 font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Enter") pushQuery({ resourceId: (e.target as HTMLInputElement).value, page: "1" })
                }}
                onBlur={(e) => {
                  if ((filters.resourceId || "") !== e.target.value) pushQuery({ resourceId: e.target.value, page: "1" })
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-xs">事件类型</Label>
              <Input
                defaultValue={filters.eventType || ""}
                placeholder="如 LOGIN_FAILED / DEVICE_KICKED"
                className="h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter") pushQuery({ eventType: (e.target as HTMLInputElement).value, page: "1" })
                }}
                onBlur={(e) => {
                  if ((filters.eventType || "") !== e.target.value) pushQuery({ eventType: e.target.value, page: "1" })
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">成功/失败</Label>
              <Select
                value={filters.success || "__all__"}
                onValueChange={(v) => pushQuery({ success: v === "__all__" ? undefined : v, page: "1" })}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">全部</SelectItem>
                  <SelectItem value="true">成功</SelectItem>
                  <SelectItem value="false">失败</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        {(Object.keys(filters).some((k) => !["tab"].includes(k)) || keyword) && (
          <div className="sm:col-span-2 lg:col-span-4">
            <Button size="sm" variant="ghost" onClick={() => router.push(`${pathname}?tab=${tab}`)}>
              清除全部筛选
            </Button>
          </div>
        )}
      </div>

      {/* 表格 */}
      {isAudit ? (
        <DataTable
          columns={auditColumns}
          rows={auditRows}
          total={total}
          page={page}
          pageSize={pageSize}
          keyword={keyword}
          sortField={sortField}
          sortOrder={sortOrder}
          onQueryChange={pushQuery}
          emptyText="暂无审计记录"
          filters={[
            {
              key: "severity",
              placeholder: "级别",
              options: [
                { label: "INFO", value: "INFO" },
                { label: "WARN", value: "WARN" },
                { label: "CRITICAL", value: "CRITICAL" },
                { label: "DANGER", value: "DANGER" },
              ],
            },
          ]}
          rowActions={(row) => (
            <Button size="sm" variant="ghost" onClick={() => setDetail(row)}>
              <Eye className="h-4 w-4" />
            </Button>
          )}
        />
      ) : (
        <DataTable
          columns={securityColumns}
          rows={securityRows}
          total={total}
          page={page}
          pageSize={pageSize}
          keyword={keyword}
          sortField={sortField}
          sortOrder={sortOrder}
          onQueryChange={pushQuery}
          emptyText="暂无安全事件"
          rowActions={(row) => (
            <Button size="sm" variant="ghost" onClick={() => setSecDetail(row)}>
              <Eye className="h-4 w-4" />
            </Button>
          )}
        />
      )}

      {/* 审计详情弹窗 */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail?.severity || "INFO"} />
              <span className="font-mono text-base">{detail?.operationType}</span>
            </DialogTitle>
            <DialogDescription>
              {detail?.resourceType} · {detail?.resourceName || "-"} · {detail?.createdAt}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">操作人</p>
              <p>{detail?.operatorName || "系统"}{detail?.operatorUserId ? `（${detail.operatorUserId.slice(0, 12)}）` : ""}</p>
            </div>
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">客户端 IP</p>
              <p className="font-mono">{detail?.clientIp || "-"}</p>
            </div>
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">资源ID</p>
              <p className="font-mono text-xs break-all">{detail?.resourceId || "-"}</p>
            </div>
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">TraceID</p>
              <p className="font-mono text-xs break-all">{detail?.traceId || "-"}</p>
            </div>
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">资源所有者 / 创建人</p>
              <p className="font-mono text-xs break-all">
                {detail?.ownerUserId || "-"} / {detail?.createdByUserId || "-"}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">变更内容（JSON Diff）</p>
            <DiffView beforeStr={detail?.beforeJson || null} afterStr={detail?.afterJson || null} />
          </div>

          {detail?.extraJson && (
            <div>
              <p className="mb-2 text-sm font-medium">扩展信息（extra）</p>
              <ScrollArea className="max-h-40">
                <pre className="rounded-md border bg-muted/40 p-2 text-[11px] font-mono whitespace-pre-wrap break-all">
                  {stableStr(parseObj(detail.extraJson))}
                </pre>
              </ScrollArea>
            </div>
          )}

          {/* 一键回滚：把 before 快照写回资源（管理员；布尔态/策略/配额类变更） */}
          {showRollback && detail && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <Undo2 className="h-4 w-4 text-amber-600" />
                    回滚此变更
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {detailRollable
                      ? "把上方 before 快照中的启停/策略/配额字段写回资源；回滚动作本身会写入审计（可再次回滚）"
                      : "该操作类型不支持一键回滚（支持启停/策略/配额类变更；删除类请使用回收站恢复，创建类请直接删除）"}
                  </p>
                </div>
                {detailRollable && (
                  <Button size="sm" variant="outline" className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 shrink-0" onClick={doRollback} disabled={rolling}>
                    {rolling ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}
                    回滚到此操作之前
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 安全事件详情弹窗 */}
      <Dialog open={!!secDetail} onOpenChange={(v) => !v && setSecDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <StatusBadge status={secDetail?.success ? "SUCCESS" : "FAILED"} />
              <span className="font-mono">{secDetail?.eventType}</span>
            </DialogTitle>
            <DialogDescription>{secDetail?.createdAt}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between rounded-md border p-2.5">
              <span className="text-muted-foreground">用户</span>
              <span>{secDetail?.username || secDetail?.userId?.slice(0, 12) || "-"}</span>
            </div>
            <div className="flex justify-between rounded-md border p-2.5">
              <span className="text-muted-foreground">IP</span>
              <span className="font-mono">{secDetail?.ip || "-"}</span>
            </div>
            <div className="rounded-md border p-2.5">
              <p className="text-xs text-muted-foreground mb-1">User-Agent</p>
              <p className="text-xs font-mono break-all">{secDetail?.userAgent || "-"}</p>
            </div>
            <div className="rounded-md border p-2.5">
              <p className="text-xs text-muted-foreground mb-1">详情</p>
              <p className="text-xs break-all">{secDetail?.detail || "-"}</p>
            </div>
            <div className="flex justify-between rounded-md border p-2.5">
              <span className="text-muted-foreground">TraceID</span>
              <span className="text-xs font-mono">{secDetail?.traceId || "-"}</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
