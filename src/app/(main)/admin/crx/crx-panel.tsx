"use client"

// ============================================================
// CRX 管控中心交互面板（客户端）
// 页签：插件库（CRUD/CSV 导入/引用关系/回收站）/ 沙箱插件状态（重试/源改写/继承开关）
//      / 灰度任务（创建/回滚）/ 黑名单 / 扩展审计（统一筛选）
// RBAC：canManage（ADMIN+）/ isSuper（SUPER_ADMIN）控制按钮显隐
// ============================================================

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  Puzzle, Loader2, Plus, Pencil, Trash2, RotateCcw, Ban, Upload, GitBranch, RefreshCw,
  ShieldAlert, Eye, Search, Send, Undo2, ShieldOff, Link2, Inbox, CheckCircle2, XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable, StatusBadge } from "@/components/shared/data-table"
import { UnifiedFilterBar } from "@/components/shared/filter-bar"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import {
  saveCrxPluginAction, toggleCrxPluginAction, recycleCrxPluginAction, restoreCrxPluginAction,
  destroyCrxPluginAction, importCrxCsvAction, saveCrxPolicyEntryAction, removeCrxPolicyEntryAction,
  saveCrxBlocklistAction, removeCrxBlocklistAction, retryCrxInstallAction,
  createCrxGrayTaskAction, rollbackCrxGrayTaskAction, setSandboxCrxSettingsAction,
} from "@/server/actions/crx"
import { cn } from "@/lib/utils"

// ---- 行类型（与 RSC 对齐）----
export interface CrxPluginRow {
  id: string
  crxId: string
  name: string
  description: string
  zhNote: string
  tags: string[]
  permissions: string[]
  updateUrl: string
  backupUpdateUrl: string
  lockedVersion: string
  allowIncognito: boolean
  allowUserDisable: boolean
  highRisk: boolean
  highRiskReason: string[]
  enabled: boolean
  docUrl: string
  createdByName: string
  updatedByName: string
  updatedAt: string
  deletedAt: string | null
  deletedByName: string
}

export interface CrxStatusRow {
  id: string
  workspaceId: string
  workspaceName: string
  workspaceStatus: string
  crxId: string
  state: string
  sourceUsed: string
  currentVersion: string
  attempts: number
  lastErrorCode: string
  lastCheckedAt: string
  updatedAt: string
}

export interface CrxGrayRow {
  id: string
  name: string
  status: string
  batchSize: number
  total: number
  progressed: number
  successCount: number
  failCount: number
  rollbackReason: string
  createdByName: string
  createdAt: string
  entries: Array<{ crxId: string }>
}

export interface CrxBlockRow {
  id: string
  scopeType: string
  scopeId: string
  crxId: string
  note: string
  createdByName: string
  createdAt: string
}

export interface CrxAuditRow {
  id: string
  operatorName: string
  operationType: string
  resourceId: string
  resourceName: string
  severity: string
  afterJson: string
  createdAt: string
}

export interface CrxWorkspaceOption {
  id: string
  name: string
  status: string
  ownerName: string
  crxInheritEnabled: boolean
  crxBlocklistExempt: boolean
}

export interface CrxRefMap {
  [crxId: string]: Array<{ scopeType: string; scopeId: string; note: string; lockedVersion: string; updateUrl: string }>
}

const STATE_META: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "待安装", tone: "bg-slate-100 text-slate-600" },
  POLICY_APPLIED: { label: "策略已下发", tone: "bg-sky-100 text-sky-700" },
  INSTALLED: { label: "已安装", tone: "bg-emerald-100 text-emerald-700" },
  PRIMARY_FAILED: { label: "主源失败", tone: "bg-amber-100 text-amber-700" },
  BACKUP_RETRY: { label: "备用源重试", tone: "bg-orange-100 text-orange-700" },
  ALL_FAILED: { label: "双源全失败", tone: "bg-red-100 text-red-700" },
  VERSION_MISMATCH: { label: "版本不匹配", tone: "bg-red-100 text-red-700" },
  REMOVED: { label: "已移除", tone: "bg-slate-100 text-slate-400" },
}

const SCOPE_LABEL: Record<string, string> = {
  GLOBAL: "全局", GROUP: "用户组", USER: "用户", SANDBOX: "沙箱", GRAY: "灰度任务", LIBRARY: "插件库默认",
}

export function CrxPanel({
  tab,
  pluginRows,
  totalPlugins,
  page,
  pageSize,
  keyword,
  filters,
  statusRows,
  grayRows,
  blockRows,
  auditRows,
  auditTotal,
  wsOptions,
  refMap,
  canManage,
  isSuper,
  role,
}: {
  tab: string
  pluginRows: CrxPluginRow[]
  totalPlugins: number
  page: number
  pageSize: number
  keyword?: string
  filters: Record<string, string>
  statusRows: CrxStatusRow[]
  grayRows: CrxGrayRow[]
  blockRows: CrxBlockRow[]
  auditRows: CrxAuditRow[]
  auditTotal: number
  wsOptions: CrxWorkspaceOption[]
  refMap: CrxRefMap
  canManage: boolean
  isSuper: boolean
  role: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const pushTab = (t: string) => {
    const sp = new URLSearchParams(searchParams.toString())
    sp.set("tab", t)
    sp.set("page", "1")
    router.push(`${pathname}?${sp.toString()}`)
  }

  const [pluginDialog, setPluginDialog] = React.useState<CrxPluginRow | "new" | null>(null)
  const [csvDialog, setCsvDialog] = React.useState(false)
  const [csvText, setCsvText] = React.useState("")
  const [refDialog, setRefDialog] = React.useState<CrxPluginRow | null>(null)
  const [destroyDialog, setDestroyDialog] = React.useState<CrxPluginRow | null>(null)
  const [destroyConfirm, setDestroyConfirm] = React.useState("")
  const [overrideDialog, setOverrideDialog] = React.useState<CrxStatusRow | null>(null)
  const [grayDialog, setGrayDialog] = React.useState(false)
  const [blockDialog, setBlockDialog] = React.useState(false)
  const [busy, setBusy] = React.useState("")

  // ---- 插件库表格列 ----
  const libraryColumns = [
    { key: "crxId", title: "CRX-ID / 名称", render: (p: CrxPluginRow) => (
      <div className="min-w-44">
        <div className="font-mono text-xs">{p.crxId.slice(0, 16)}…</div>
        <div className="text-sm font-medium">{p.name}</div>
        {p.zhNote && <div className="text-[11px] text-muted-foreground">{p.zhNote}</div>}
      </div>
    ) },
    { key: "tags", title: "业务标签", render: (p: CrxPluginRow) => (
      <div className="flex flex-wrap gap-1 min-w-20">
        {p.tags.map((t) => (
          <Badge key={t} variant="outline" className={cn("text-[10px]", t === "highrisk" && "border-red-200 bg-red-50 text-red-600")}>{t}</Badge>
        ))}
      </div>
    ) },
    { key: "updateUrl", title: "主源 / 备用源", render: (p: CrxPluginRow) => (
      <div className="min-w-48 max-w-72 text-xs">
        <div className="truncate font-mono" title={p.updateUrl}>{p.updateUrl}</div>
        {p.backupUpdateUrl && <div className="truncate font-mono text-muted-foreground" title={p.backupUpdateUrl}>↳ {p.backupUpdateUrl}</div>}
      </div>
    ) },
    { key: "lockedVersion", title: "锁定版本", render: (p: CrxPluginRow) => p.lockedVersion ? <Badge variant="secondary" className="font-mono text-[11px]">{p.lockedVersion}</Badge> : <span className="text-xs text-muted-foreground">自动</span> },
    { key: "flags", title: "策略位", render: (p: CrxPluginRow) => (
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground min-w-28">
        <span>无痕：{p.allowIncognito ? "允许" : "禁止"}</span>
        <span>用户禁用：{p.allowUserDisable ? "可" : "不可（强制）"}</span>
        {p.highRisk && <Badge className="w-fit bg-red-500 hover:bg-red-500 text-[10px]"><ShieldAlert className="h-3 w-3 mr-0.5" />高危 {p.highRiskReason.length} 项</Badge>}
      </div>
    ) },
    { key: "permissions", title: "权限清单", render: (p: CrxPluginRow) => (
      <div className="flex flex-wrap gap-1 min-w-32 max-w-64">
        {p.permissions.slice(0, 6).map((perm) => (
          <span key={perm} className={cn("rounded px-1 py-0.5 text-[10px] font-mono", ["all_urls", "clipboardRead", "clipboardWrite", "webRequestBlocking"].includes(perm) ? "bg-red-50 text-red-600" : "bg-muted")}>{perm}</span>
        ))}
        {p.permissions.length > 6 && <span className="text-[10px] text-muted-foreground">+{p.permissions.length - 6}</span>}
      </div>
    ) },
    { key: "enabled", title: "状态", sortable: true, render: (p: CrxPluginRow) => (
      p.deletedAt ? <Badge variant="outline" className="text-muted-foreground">回收站 · {p.deletedByName}</Badge>
        : p.enabled ? <Badge className="bg-emerald-500 hover:bg-emerald-500">启用</Badge>
        : <Badge variant="secondary">库内禁用</Badge>
    ) },
  ]

  // ---- 沙箱插件状态表格列 ----
  const statusColumns = [
    { key: "workspace", title: "沙箱", render: (s: CrxStatusRow) => (
      <div className="min-w-36">
        <div className="text-sm font-medium">{s.workspaceName}</div>
        <div className="font-mono text-[10px] text-muted-foreground">{s.workspaceId.slice(0, 12)}… · {s.workspaceStatus}</div>
      </div>
    ) },
    { key: "crxId", title: "插件", render: (s: CrxStatusRow) => <span className="font-mono text-xs">{s.crxId.slice(0, 16)}…</span> },
    { key: "state", title: "安装状态", sortable: true, render: (s: CrxStatusRow) => {
      const m = STATE_META[s.state] || { label: s.state, tone: "bg-muted" }
      return <Badge variant="outline" className={cn("text-[11px] font-medium", m.tone)}>{m.label}</Badge>
    } },
    { key: "sourceUsed", title: "当前源", render: (s: CrxStatusRow) => (
      <div className="min-w-40 max-w-64 text-xs font-mono truncate" title={s.sourceUsed}>{s.sourceUsed || "—"}</div>
    ) },
    { key: "version", title: "版本", render: (s: CrxStatusRow) => s.currentVersion ? <Badge variant="secondary" className="font-mono text-[11px]">{s.currentVersion}</Badge> : <span className="text-xs text-muted-foreground">—</span> },
    { key: "attempts", title: "尝试", render: (s: CrxStatusRow) => <span className="text-xs">{s.attempts}</span> },
    { key: "error", title: "最近错误", render: (s: CrxStatusRow) => (
      <div className="min-w-36 max-w-56 text-[11px] text-red-600 truncate" title={s.lastErrorCode}>{s.lastErrorCode || "—"}</div>
    ) },
    { key: "updatedAt", title: "最近检查", sortable: true, render: (s: CrxStatusRow) => <span className="text-xs text-muted-foreground">{s.lastCheckedAt || s.updatedAt}</span> },
  ]

  // ---- 灰度任务表格列 ----
  const grayColumns = [
    { key: "name", title: "任务", render: (t: CrxGrayRow) => (
      <div className="min-w-40">
        <div className="text-sm font-medium">{t.name}</div>
        <div className="text-[11px] text-muted-foreground">{t.createdByName} · {t.createdAt}</div>
      </div>
    ) },
    { key: "entries", title: "插件", render: (t: CrxGrayRow) => (
      <div className="flex flex-wrap gap-1 min-w-32">
        {t.entries.map((e) => <span key={e.crxId} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{e.crxId.slice(0, 8)}…</span>)}
      </div>
    ) },
    { key: "progress", title: "进度", render: (t: CrxGrayRow) => (
      <div className="min-w-32">
        <div className="flex items-center gap-2 text-xs">
          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-teal-500" style={{ width: `${t.total > 0 ? Math.round((t.progressed / t.total) * 100) : 0}%` }} />
          </div>
          <span className="font-mono">{t.progressed}/{t.total}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">成功 {t.successCount} · 失败 {t.failCount} · 批次 {t.batchSize}</div>
      </div>
    ) },
    { key: "status", title: "状态", sortable: true, render: (t: CrxGrayRow) => <StatusBadge status={t.status} /> },
  ]

  // ---- 黑名单表格列 ----
  const blockColumns = [
    { key: "scope", title: "作用域", render: (b: CrxBlockRow) => (
      <Badge variant="outline" className="text-[11px]">{SCOPE_LABEL[b.scopeType] || b.scopeType}{b.scopeId ? ` · ${b.scopeId.slice(0, 10)}…` : ""}</Badge>
    ) },
    { key: "crxId", title: "CRX-ID", render: (b: CrxBlockRow) => <span className="font-mono text-xs">{b.crxId.slice(0, 16)}…</span> },
    { key: "note", title: "备注", render: (b: CrxBlockRow) => <span className="text-xs">{b.note || "—"}</span> },
    { key: "created", title: "创建", render: (b: CrxBlockRow) => (
      <div className="text-[11px] text-muted-foreground min-w-28">{b.createdByName} · {b.createdAt}</div>
    ) },
  ]

  // ---- 扩展审计表格列 ----
  const auditColumns = [
    { key: "createdAt", title: "时间", sortable: true, render: (a: CrxAuditRow) => <span className="text-xs text-muted-foreground whitespace-nowrap">{a.createdAt}</span> },
    { key: "operationType", title: "事件类型", sortable: true, render: (a: CrxAuditRow) => <Badge variant="secondary" className="text-[11px] font-mono">{a.operationType}</Badge> },
    { key: "operatorName", title: "操作人", render: (a: CrxAuditRow) => <span className="text-sm">{a.operatorName}</span> },
    { key: "resource", title: "对象", render: (a: CrxAuditRow) => (
      <div className="min-w-36 text-xs">
        <div className="font-mono">{a.resourceId}</div>
        {a.resourceName && <div className="text-muted-foreground">{a.resourceName}</div>}
      </div>
    ) },
    { key: "severity", title: "级别", render: (a: CrxAuditRow) => <StatusBadge status={a.severity} /> },
    { key: "after", title: "详情", render: (a: CrxAuditRow) => (
      <div className="min-w-40 max-w-80">
        <pre className="max-h-16 overflow-y-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 text-[10px] leading-relaxed">{a.afterJson?.slice(0, 300)}</pre>
      </div>
    ) },
  ]

  // ---- 操作执行 ----
  const run = async (key: string, fn: () => Promise<{ code: number; msg?: string }>) => {
    setBusy(key)
    try {
      const res = await fn()
      if (res.code === 0) { toast.success("操作成功"); router.refresh() }
      else toast.error(res.msg || "操作失败")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "操作失败")
    } finally { setBusy("") }
  }

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={pushTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="library"><Puzzle className="mr-1 h-3.5 w-3.5" />插件库</TabsTrigger>
          <TabsTrigger value="status"><GitBranch className="mr-1 h-3.5 w-3.5" />沙箱插件状态</TabsTrigger>
          <TabsTrigger value="gray"><Undo2 className="mr-1 h-3.5 w-3.5" />灰度任务</TabsTrigger>
          <TabsTrigger value="blocklist"><ShieldOff className="mr-1 h-3.5 w-3.5" />黑名单</TabsTrigger>
          <TabsTrigger value="audit"><Search className="mr-1 h-3.5 w-3.5" />扩展审计</TabsTrigger>
          <TabsTrigger value="recycle"><Inbox className="mr-1 h-3.5 w-3.5" />插件回收站</TabsTrigger>
        </TabsList>

      {/* ================= 插件库 ================= */}
      <TabsContent value="library" className="space-y-3">
        <UnifiedFilterBar
          keyword={keyword}
          filters={filters}
          keywordPlaceholder="搜索 CRX-ID / 名称 / 备注…"
          selectDefs={[
            { key: "enabled", label: "状态", options: [{ label: "启用", value: "true" }, { label: "禁用", value: "false" }] },
            { key: "highRisk", label: "高危", options: [{ label: "仅高危", value: "true" }] },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <>
              <Button size="sm" onClick={() => setPluginDialog("new")}><Plus className="mr-1 h-3.5 w-3.5" />新增插件</Button>
              <Button size="sm" variant="outline" onClick={() => setCsvDialog(true)}><Upload className="mr-1 h-3.5 w-3.5" />CSV 批量导入</Button>
            </>
          )}
          <span className="ml-auto text-xs text-muted-foreground">五级策略优先级：沙箱单插件 &gt; 用户 &gt; 用户组 &gt; 全局 &gt; 插件库默认</span>
        </div>
        <DataTable
          columns={libraryColumns}
          rows={pluginRows}
          total={totalPlugins}
          page={page}
          pageSize={pageSize}
          keyword={keyword}
          filters={[{ key: "enabled", placeholder: "状态" }, { key: "highRisk", placeholder: "高危" }]}
          rowActions={(p) => (
            <div className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setRefDialog(p)} title="查看引用关系"><Link2 className="h-3.5 w-3.5" /></Button>
              {canManage && !p.deletedAt && (
                <>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setPluginDialog(p)} title="编辑"><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant="ghost" className="h-7" title={p.enabled ? "禁用" : "启用"}
                    onClick={() => run(`toggle-${p.crxId}`, () => toggleCrxPluginAction({ crxId: p.crxId, enabled: !p.enabled }))}>
                    {busy === `toggle-${p.crxId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : p.enabled ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-red-600" title="移入回收站"
                    onClick={() => run(`recycle-${p.crxId}`, () => recycleCrxPluginAction({ crxId: p.crxId }))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          )}
          emptyText="插件库为空 —— 新增插件或 CSV 批量导入（所有下发的 CRX 必须先入库）"
        />
      </TabsContent>

      {/* ================= 沙箱插件状态 ================= */}
      <TabsContent value="status" className="space-y-3">
        <UnifiedFilterBar
          keyword={keyword}
          filters={filters}
          keywordPlaceholder="搜索沙箱 ID / 插件 CRX-ID…"
          selectDefs={[
            { key: "state", label: "安装状态", options: Object.entries(STATE_META).map(([v, m]) => ({ label: m.label, value: v })) },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => run("retry-all", () => retryCrxInstallAction({ all: true }))}>
              {busy === "retry-all" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
              批量重试全部失败插件
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            状态机：待安装 → 策略下发 → 已安装；主源失败 → 备用源重试 → 双源全失败（停止自动重试，等手动）
          </span>
        </div>
        <DataTable
          columns={statusColumns}
          rows={statusRows}
          total={statusRows.length}
          page={1}
          pageSize={200}
          emptyText="暂无安装状态 —— 运行中的沙箱由 crx_install_poll 任务每分钟自动轮询"
          rowActions={(s) => (
            <div className="flex flex-wrap items-center gap-1">
              {canManage && ["PRIMARY_FAILED", "BACKUP_RETRY", "ALL_FAILED", "VERSION_MISMATCH"].includes(s.state) && (
                <Button size="sm" variant="ghost" className="h-7" title="手动重试"
                  onClick={() => run(`retry-${s.id}`, () => retryCrxInstallAction({ workspaceId: s.workspaceId, crxId: s.crxId }))}>
                  {busy === `retry-${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </Button>
              )}
              {canManage && (
                <Button size="sm" variant="ghost" className="h-7" title="改写本沙箱此插件源/版本（SANDBOX 单插件级）" onClick={() => setOverrideDialog(s)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        />
        {/* 沙箱级 CRX 设置（继承开关） */}
        <div className="rounded-lg border p-4 space-y-2">
          <p className="text-sm font-medium flex items-center gap-2"><GitBranch className="h-4 w-4 text-teal-600" />沙箱扩展继承开关（关闭继承 = 完全使用沙箱自己的插件列表；黑名单仍强制继承）</p>
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {wsOptions.slice(0, 24).map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{w.name}</div>
                  <div className="text-[10px] text-muted-foreground">{w.ownerName} · {w.status}</div>
                </div>
                <Switch
                  checked={w.crxInheritEnabled}
                  disabled={!canManage || busy === `inherit-${w.id}`}
                  onCheckedChange={(b) => run(`inherit-${w.id}`, () => setSandboxCrxSettingsAction({ workspaceId: w.id, crxInheritEnabled: b }))}
                  aria-label={`继承开关 ${w.name}`}
                />
              </div>
            ))}
            {wsOptions.length === 0 && <p className="text-xs text-muted-foreground">暂无可配置沙箱</p>}
          </div>
        </div>
      </TabsContent>

      {/* ================= 灰度任务 ================= */}
      <TabsContent value="gray" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button size="sm" onClick={() => setGrayDialog(true)}><Plus className="mr-1 h-3.5 w-3.5" />创建灰度下发</Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">分批推送 CRX 变更到选定沙箱（每批写入 SANDBOX 级策略并等待轮询验证）；回滚仅超级管理员</span>
        </div>
        <DataTable
          columns={grayColumns}
          rows={grayRows}
          total={grayRows.length}
          page={1}
          pageSize={50}
          emptyText="暂无灰度任务"
          rowActions={(t) => (
            <div className="flex items-center gap-1">
              {isSuper && ["PENDING", "ROLLING", "PARTIAL"].includes(t.status) && (
                <Button size="sm" variant="outline" className="h-7 border-red-200 text-red-600 hover:bg-red-50"
                  title="回滚（仅超管）：移除本任务写入的全部沙箱插件策略"
                  onClick={() => {
                    const reason = window.prompt("回滚原因（可选）：", "") ?? ""
                    run(`rollback-${t.id}`, () => rollbackCrxGrayTaskAction({ id: t.id, reason }))
                  }}>
                  {busy === `rollback-${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} 回滚
                </Button>
              )}
              {t.rollbackReason && <span className="text-[11px] text-red-600 max-w-40 truncate" title={t.rollbackReason}>{t.rollbackReason}</span>}
            </div>
          )}
        />
      </TabsContent>

      {/* ================= 黑名单 ================= */}
      <TabsContent value="blocklist" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Button size="sm" onClick={() => setBlockDialog(true)}><Plus className="mr-1 h-3.5 w-3.5" />新增黑名单</Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">ExtensionInstallBlocklist —— 黑名单不随沙箱继承开关失效（超管可为单沙箱开豁免）</span>
        </div>
        <DataTable
          columns={blockColumns}
          rows={blockRows}
          total={blockRows.length}
          page={1}
          pageSize={100}
          emptyText="黑名单为空"
          rowActions={(b) => canManage ? (
            <Button size="sm" variant="ghost" className="h-7 text-red-600" title="移除"
              onClick={() => run(`rm-block-${b.id}`, () => removeCrxBlocklistAction({ id: b.id }))}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        />
      </TabsContent>

      {/* ================= 扩展审计 ================= */}
      <TabsContent value="audit" className="space-y-3">
        <UnifiedFilterBar
          keyword={keyword}
          filters={filters}
          keywordPlaceholder="搜索操作人 / 资源 ID…"
          selectDefs={[
            { key: "operationType", label: "事件类型", options: [
              { label: "插件新增", value: "CRX_PLUGIN_CREATE" },
              { label: "插件编辑", value: "CRX_PLUGIN_UPDATE" },
              { label: "启用/禁用", value: "CRX_PLUGIN_DISABLE" },
              { label: "回收/销毁", value: "CRX_PLUGIN_RECYCLE" },
              { label: "策略条目保存", value: "CRX_POLICY_ENTRY_SAVE" },
              { label: "源切换降级", value: "CRX_SOURCE_FAILOVER" },
              { label: "手动重试", value: "CRX_INSTALL_RETRY" },
              { label: "灰度创建", value: "CRX_GRAY_CREATE" },
              { label: "灰度回滚", value: "CRX_GRAY_ROLLBACK" },
            ] },
          ]}
        />
        <DataTable
          columns={auditColumns}
          rows={auditRows}
          total={auditTotal}
          page={page}
          pageSize={pageSize}
          keyword={keyword}
          filters={[{ key: "operationType", placeholder: "事件类型" }]}
          emptyText="暂无 CRX 审计事件"
        />
      </TabsContent>

      {/* ================= 插件回收站 ================= */}
      <TabsContent value="recycle" className="space-y-3">
        <UnifiedFilterBar keyword={keyword} filters={filters} keywordPlaceholder="搜索回收站插件…" selectDefs={[]} />
        <DataTable
          columns={libraryColumns}
          rows={pluginRows}
          total={totalPlugins}
          page={page}
          pageSize={pageSize}
          keyword={keyword}
          emptyText="回收站为空"
          rowActions={(p) => (
            <div className="flex flex-wrap items-center gap-1">
              {canManage && (
                <Button size="sm" variant="ghost" className="h-7" title="恢复"
                  onClick={() => run(`restore-${p.crxId}`, () => restoreCrxPluginAction({ crxId: p.crxId }))}>
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
              {isSuper && (
                <Button size="sm" variant="ghost" className="h-7 text-red-600" title="彻底删除（超管 · 二次确认 · 引用校验）"
                  onClick={() => { setDestroyDialog(p); setDestroyConfirm("") }}>
                  <XCircle className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        />
      </TabsContent>
      </Tabs>

      {/* ================= 对话框组 ================= */}
      {/* 插件新增/编辑 */}
      <PluginDialog
        open={pluginDialog !== null}
        plugin={pluginDialog === "new" ? null : pluginDialog}
        canManage={canManage}
        busy={busy}
        onClose={() => setPluginDialog(null)}
        onSaved={() => { setPluginDialog(null); router.refresh() }}
      />

      {/* CSV 批量导入 */}
      <Dialog open={csvDialog} onOpenChange={setCsvDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>CSV 批量导入插件</DialogTitle>
            <DialogDescription>
              每行一条：<code className="font-mono text-xs">crxId,updateUrl[,backupUpdateUrl[,name]]</code>。ID/源格式非法或已存在的行自动跳过并在结果中说明；全部写入审计。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={8}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={"# crxId,updateUrl,backupUpdateUrl,name\ncjpalhdlnbpafiamejdnhcphjbkeiagm,https://clients2.google.com/service/update2/crx,,uBlock Origin"}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCsvDialog(false)}>取消</Button>
            <Button disabled={!csvText.trim() || busy === "csv"} onClick={async () => {
              setBusy("csv")
              try {
                const res = await importCrxCsvAction({ csv: csvText })
                if (res.code === 0 && res.data) {
                  toast.success(`导入 ${res.data.imported} 个插件${res.data.skipped.length ? `，跳过 ${res.data.skipped.length} 行` : ""}`)
                  if (res.data.skipped.length) toast.info(`跳过：${res.data.skipped.slice(0, 3).join("；")}${res.data.skipped.length > 3 ? "…" : ""}`)
                  setCsvDialog(false); setCsvText(""); router.refresh()
                } else toast.error(res.msg)
              } catch (e) { toast.error(e instanceof Error ? e.message : "导入失败") }
              finally { setBusy("") }
            }}>
              {busy === "csv" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 开始导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 引用关系 */}
      <Dialog open={!!refDialog} onOpenChange={(o) => !o && setRefDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Link2 className="h-4 w-4 text-teal-600" />引用关系：{refDialog?.name}</DialogTitle>
            <DialogDescription>该 CRX 被哪些作用域引用（模板/用户组/用户/沙箱/灰度任务）。删除前必须清空全部引用。</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto space-y-1.5">
            {(refDialog && refMap[refDialog.crxId]?.length ? refMap[refDialog.crxId] : []).map((r, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{SCOPE_LABEL[r.scopeType] || r.scopeType}</Badge>
                  <span className="font-mono text-[11px]">{r.scopeId || "（全局）"}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {r.lockedVersion && <Badge variant="secondary" className="font-mono text-[10px]">v{r.lockedVersion}</Badge>}
                  {r.updateUrl && <span className="max-w-48 truncate font-mono" title={r.updateUrl}>{r.updateUrl}</span>}
                  {r.note && <span>{r.note}</span>}
                  {canManage && r.scopeType !== "GRAY" && (
                    <Button size="sm" variant="ghost" className="h-6 text-red-600" title="移除该引用"
                      onClick={() => {
                        const sp = new URLSearchParams(searchParams.toString())
                        void sp
                        toast.info("请在对应作用域（策略中心/用户/沙箱）移除该引用条目")
                      }}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {refDialog && !refMap[refDialog.crxId]?.length && (
              <p className="py-6 text-center text-sm text-muted-foreground">该插件暂无任何引用（未下发到任何作用域）</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 彻底删除（超管二次确认） */}
      <Dialog open={!!destroyDialog} onOpenChange={(o) => { if (!o) { setDestroyDialog(null); setDestroyConfirm("") } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><XCircle className="h-4 w-4 text-red-600" />彻底删除插件（不可恢复）</DialogTitle>
            <DialogDescription>
              仅超级管理员可执行。删除前自动校验引用关系（存在引用将被拒绝）；输入插件名称 <b className="text-foreground">{destroyDialog?.name}</b> 二次确认。
            </DialogDescription>
          </DialogHeader>
          <Input value={destroyConfirm} onChange={(e) => setDestroyConfirm(e.target.value)} placeholder="输入插件名称确认" />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDestroyDialog(null); setDestroyConfirm("") }}>取消</Button>
            <Button variant="destructive" disabled={destroyConfirm !== destroyDialog?.name || busy === "destroy"}
              onClick={() => destroyDialog && run("destroy", async () => {
                const r = await destroyCrxPluginAction({ crxId: destroyDialog.crxId, confirmName: destroyConfirm })
                setDestroyDialog(null); setDestroyConfirm("")
                return r
              })}>
              {busy === "destroy" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 确认彻底删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 沙箱单插件源/版本覆盖（五级最高优先级） */}
      <OverrideDialog
        open={!!overrideDialog}
        statusRow={overrideDialog}
        onClose={() => setOverrideDialog(null)}
        onSaved={() => { setOverrideDialog(null); router.refresh() }}
      />

      {/* 创建灰度任务 */}
      <GrayDialog
        open={grayDialog}
        plugins={pluginRows.filter((p) => p.enabled && !p.deletedAt)}
        workspaces={wsOptions}
        onClose={() => setGrayDialog(false)}
        onCreated={() => { setGrayDialog(false); router.refresh() }}
      />

      {/* 新增黑名单 */}
      <Dialog open={blockDialog} onOpenChange={setBlockDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增 CRX 黑名单</DialogTitle>
            <DialogDescription>写入 Chromium ExtensionInstallBlocklist —— 该扩展在本作用域内完全禁止安装。与强制安装列表互斥（同作用域同时存在将被拦截）。</DialogDescription>
          </DialogHeader>
          <BlockForm
            canManage={canManage}
            onSaved={() => { setBlockDialog(false); router.refresh() }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============================================================
// 插件新增/编辑对话框
// ============================================================
function PluginDialog({ open, plugin, canManage, busy, onClose, onSaved }: {
  open: boolean
  plugin: CrxPluginRow | null
  canManage: boolean
  busy: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = React.useState({
    crxId: "", name: "", description: "", zhNote: "", tags: "", permissions: "",
    updateUrl: "", backupUpdateUrl: "", lockedVersion: "",
    allowIncognito: false, allowUserDisable: true, docUrl: "",
  })
  React.useEffect(() => {
    if (plugin) {
      setForm({
        crxId: plugin.crxId, name: plugin.name, description: plugin.description, zhNote: plugin.zhNote,
        tags: plugin.tags.join(","), permissions: plugin.permissions.join(","),
        updateUrl: plugin.updateUrl, backupUpdateUrl: plugin.backupUpdateUrl, lockedVersion: plugin.lockedVersion,
        allowIncognito: plugin.allowIncognito, allowUserDisable: plugin.allowUserDisable, docUrl: plugin.docUrl,
      })
    } else {
      setForm({ crxId: "", name: "", description: "", zhNote: "", tags: "", permissions: "", updateUrl: "", backupUpdateUrl: "", lockedVersion: "", allowIncognito: false, allowUserDisable: true, docUrl: "" })
    }
  }, [plugin, open])

  const [saving, setSaving] = React.useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const res = await saveCrxPluginAction({ id: plugin?.id, ...form })
      if (res.code === 0) {
        toast.success(plugin ? "插件已更新" : "插件已入库")
        if (!plugin) toast.info(res.data?.highRisk ? "高危权限自动标记完成" : "提示：可继续配置五级策略下发")
        onSaved()
      } else toast.error(res.msg)
    } catch (e) { toast.error(e instanceof Error ? e.message : "保存失败") }
    finally { setSaving(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Puzzle className="h-4 w-4 text-teal-600" />{plugin ? `编辑插件：${plugin.name}` : "新增 CRX 插件（入库）"}</DialogTitle>
          <DialogDescription>
            后台只维护扩展 ID 与 update_url 元数据（不存 CRX 二进制）。权限清单将自动判定高危标记；源地址/版本格式实时校验。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">CRX-ID（32 位 a-p，Chrome/Edge 商店真实 ID）</Label>
            <Input value={form.crxId} onChange={(e) => setForm({ ...form, crxId: e.target.value })} disabled={!!plugin} className="font-mono text-xs" placeholder="cjpalhdlnbpafiamejdnhcphjbkeiagm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">插件显示名称</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="uBlock Origin" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">主安装源 update_url（http/https）</Label>
            <Input value={form.updateUrl} onChange={(e) => setForm({ ...form, updateUrl: e.target.value })} className="font-mono text-xs" placeholder="https://clients2.google.com/service/update2/crx" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">备用安装源（降级用，可空）</Label>
            <Input value={form.backupUpdateUrl} onChange={(e) => setForm({ ...form, backupUpdateUrl: e.target.value })} className="font-mono text-xs" placeholder="https://edge.microsoft.com/…（内网镜像填 http://mirror.local/crx）" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">强制锁定版本（可空 = 自动升级）</Label>
            <Input value={form.lockedVersion} onChange={(e) => setForm({ ...form, lockedVersion: e.target.value })} className="font-mono text-xs" placeholder="1.2.3.4" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">业务标签（逗号分隔：office/dev/ops/highrisk）</Label>
            <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="office,dev" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">manifest 权限清单（逗号分隔；高危权限自动标记）</Label>
            <Input value={form.permissions} onChange={(e) => setForm({ ...form, permissions: e.target.value })} className="font-mono text-xs" placeholder="tabs,storage,all_urls,clipboardWrite" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">中文备注</Label>
            <Input value={form.zhNote} onChange={(e) => setForm({ ...form, zhNote: e.target.value })} placeholder="办公标配：广告拦截" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">内部文档链接（可空）</Label>
            <Input value={form.docUrl} onChange={(e) => setForm({ ...form, docUrl: e.target.value })} placeholder="https://wiki.internal/crx/…" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-xs">允许无痕窗口运行</span>
              <Switch checked={form.allowIncognito} onCheckedChange={(b) => setForm({ ...form, allowIncognito: b })} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-xs">允许用户手动禁用（关=force_installed 强制）</span>
              <Switch checked={form.allowUserDisable} onCheckedChange={(b) => setForm({ ...form, allowUserDisable: b })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          {canManage && (
            <Button onClick={save} disabled={saving || !form.crxId || !form.name || !form.updateUrl}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} {plugin ? "保存修改" : "入库"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 沙箱单插件源/版本覆盖对话框（五级最高优先级）
// ============================================================
function OverrideDialog({ open, statusRow, onClose, onSaved }: {
  open: boolean
  statusRow: CrxStatusRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const [updateUrl, setUpdateUrl] = React.useState("")
  const [backupUpdateUrl, setBackupUpdateUrl] = React.useState("")
  const [lockedVersion, setLockedVersion] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => {
    if (statusRow) { setUpdateUrl(statusRow.sourceUsed || ""); setBackupUpdateUrl(""); setLockedVersion("") }
  }, [statusRow, open])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4 text-teal-600" />沙箱单插件独立配置（最高优先级）</DialogTitle>
          <DialogDescription>
            仅影响 <b>{statusRow?.workspaceName}</b> 的 <code className="font-mono text-[11px]">{statusRow?.crxId.slice(0, 12)}…</code>：可单独改写主源/备用源/锁定版本（例如切换到公司私有扩展镜像），不影响其他沙箱。修改写入 SANDBOX 级策略 + 审计。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">主 update_url（留空 = 沿用插件库默认）</Label>
            <Input value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} className="font-mono text-xs" placeholder="http://crx-mirror.internal/service/update2/crx" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">备用 update_url（留空 = 不覆盖）</Label>
            <Input value={backupUpdateUrl} onChange={(e) => setBackupUpdateUrl(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">锁定版本（留空 = 不覆盖）</Label>
            <Input value={lockedVersion} onChange={(e) => setLockedVersion(e.target.value)} className="font-mono text-xs" placeholder="2.1.0" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={saving || !statusRow} onClick={async () => {
            if (!statusRow) return
            setSaving(true)
            try {
              const res = await saveCrxPolicyEntryAction({
                scopeType: "SANDBOX", scopeId: statusRow.workspaceId, crxId: statusRow.crxId,
                updateUrl, backupUpdateUrl, lockedVersion, note: "管理员单插件源改写",
              })
              if (res.code === 0) {
                toast.success("沙箱单插件策略已写入（本沙箱独立生效）")
                await retryCrxInstallAction({ workspaceId: statusRow.workspaceId, crxId: statusRow.crxId })
                onSaved()
              } else toast.error(res.msg)
            } catch (e) { toast.error(e instanceof Error ? e.message : "保存失败") }
            finally { setSaving(false) }
          }}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 保存并触发重试
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 灰度任务创建对话框
// ============================================================
function GrayDialog({ open, plugins, workspaces, onClose, onCreated }: {
  open: boolean
  plugins: CrxPluginRow[]
  workspaces: CrxWorkspaceOption[]
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = React.useState("")
  const [selectedPlugins, setSelectedPlugins] = React.useState<string[]>([])
  const [selectedWs, setSelectedWs] = React.useState<string[]>([])
  const [batchSize, setBatchSize] = React.useState(3)
  const [updateUrl, setUpdateUrl] = React.useState("")
  const [creating, setCreating] = React.useState(false)

  const toggle = (arr: string[], v: string, set: (a: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Undo2 className="h-4 w-4 text-teal-600" />创建 CRX 灰度下发任务</DialogTitle>
          <DialogDescription>
            按批次将选中插件写入目标沙箱的 SANDBOX 级策略（每批 {batchSize} 个沙箱，由 crx_gray_rollout 每分钟推进）；
            观察告警无异常后可全量下发；回滚仅超级管理员。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">任务名称</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="内网插件灰度-第一批" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">批次大小（1-20）</Label>
              <Input type="number" min={1} max={20} value={batchSize} onChange={(e) => setBatchSize(Math.max(1, Math.min(20, Number(e.target.value) || 3)))} className="w-24" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">统一覆盖源（可空）</Label>
              <Input value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} className="font-mono text-xs" placeholder="http://mirror.internal/crx" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">选择插件（{selectedPlugins.length} 已选）</Label>
            <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
              {plugins.map((p) => (
                <label key={p.crxId} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
                  <input type="checkbox" checked={selectedPlugins.includes(p.crxId)} onChange={() => toggle(selectedPlugins, p.crxId, setSelectedPlugins)} className="accent-teal-500" />
                  <span className="truncate">{p.name}</span>
                  {p.highRisk && <Badge className="bg-red-500 hover:bg-red-500 text-[9px] px-1">高危</Badge>}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">目标沙箱（{selectedWs.length} / {workspaces.length} 已选）</Label>
            <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
              {workspaces.map((w) => (
                <label key={w.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent">
                  <input type="checkbox" checked={selectedWs.includes(w.id)} onChange={() => toggle(selectedWs, w.id, setSelectedWs)} className="accent-teal-500" />
                  <span className="truncate">{w.name}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{w.ownerName} · {w.status}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={creating || !name || selectedPlugins.length === 0 || selectedWs.length === 0}
            onClick={async () => {
              setCreating(true)
              try {
                const res = await createCrxGrayTaskAction({
                  name, crxIds: selectedPlugins, workspaceIds: selectedWs, batchSize, updateUrl,
                })
                if (res.code === 0) { toast.success("灰度任务已创建（ROLLING 引擎每分钟推进）"); onCreated() }
                else toast.error(res.msg)
              } catch (e) { toast.error(e instanceof Error ? e.message : "创建失败") }
              finally { setCreating(false) }
            }}>
            {creating && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 黑名单表单
// ============================================================
function BlockForm({ canManage, onSaved }: { canManage: boolean; onSaved: () => void }) {
  const [scopeType, setScopeType] = React.useState("GLOBAL")
  const [crxId, setCrxId] = React.useState("")
  const [note, setNote] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  return (
    <div className="space-y-3">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">作用域</Label>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="GLOBAL">全局（全部沙箱）</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">CRX-ID（32 位）</Label>
          <Input value={crxId} onChange={(e) => setCrxId(e.target.value)} className="font-mono text-xs" placeholder="gkbmnajbmkcpljcgbjkmfnfmaagjgbgc" />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">备注</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="历史高危工具，全局禁止" />
      </div>
      <Button disabled={!canManage || saving || crxId.length !== 32} onClick={async () => {
        setSaving(true)
        try {
          const res = await saveCrxBlocklistAction({ scopeType, scopeId: "", crxId, note })
          if (res.code === 0) { toast.success("黑名单已写入（ExtensionInstallBlocklist）"); onSaved() }
          else toast.error(res.msg)
        } catch (e) { toast.error(e instanceof Error ? e.message : "保存失败") }
        finally { setSaving(false) }
      }}>
        {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} 加入黑名单
      </Button>
    </div>
  )
}
