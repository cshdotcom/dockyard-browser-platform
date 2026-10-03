"use client"

// ============================================================
// r26：模板版本历史弹窗 — 快照列表 / 任意两版差异对比（CRX 变更高亮）/ 一键回滚
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { GitBranch, History, Loader2, RotateCcw, Eye, Diff, CheckCircle2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  listTemplateVersionsAction, diffTemplateVersionsAction, rollbackTemplateVersionAction,
} from "@/server/actions/templates"

interface VersionRow {
  version: number
  changeNote: string | null
  changedFields: string[]
  createdByName: string | null
  createdAt: string
}

interface DiffItem {
  field: string
  before: string
  after: string
  kind: "ADDED" | "REMOVED" | "CHANGED"
  crxRelated: boolean
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  template: { id: string; name: string; version: number } | null
  canRollback: boolean // 普通用户仅自己的模板；全局模板仅管理员（与编辑权限同语义）
}

export function TemplateVersionHistoryDialog({ open, onOpenChange, template, canRollback }: Props) {
  const [versions, setVersions] = React.useState<VersionRow[]>([])
  const [loading, setLoading] = React.useState(false)
  const [diffFrom, setDiffFrom] = React.useState<string>("")
  const [diffTo, setDiffTo] = React.useState<string>("")
  const [diffItems, setDiffItems] = React.useState<DiffItem[] | null>(null)
  const [crxCount, setCrxCount] = React.useState(0)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [rollbackTarget, setRollbackTarget] = React.useState<VersionRow | null>(null)
  const [rolling, setRolling] = React.useState(false)

  React.useEffect(() => {
    if (open && template) {
      setLoading(true)
      setDiffItems(null)
      listTemplateVersionsAction({ templateId: template.id })
        .then((res) => {
          if (res.code === 0 && res.data) {
            setVersions(res.data.versions)
            // 默认对比：倒数第二版 vs 最新版
            if (res.data.versions.length >= 2) {
              setDiffFrom(String(res.data.versions[1].version))
              setDiffTo(String(res.data.versions[0].version))
            } else if (res.data.versions.length === 1) {
              setDiffFrom(String(res.data.versions[0].version))
              setDiffTo(String(res.data.versions[0].version))
            }
          } else {
            toast.error(res.msg || "版本历史加载失败")
          }
        })
        .finally(() => setLoading(false))
    }
  }, [open, template])

  const runDiff = async () => {
    if (!template || !diffFrom || !diffTo) return
    setDiffLoading(true)
    const res = await diffTemplateVersionsAction({
      templateId: template.id, fromVersion: Number(diffFrom), toVersion: Number(diffTo),
    })
    setDiffLoading(false)
    if (res.code === 0 && res.data) {
      setDiffItems(res.data.items)
      setCrxCount(res.data.crxChangeCount)
      if (res.data.items.length === 0) toast.info("两个版本配置完全一致（无字段差异）")
    } else {
      toast.error(res.msg || "差异对比失败")
    }
  }

  React.useEffect(() => {
    if (diffFrom && diffTo && open && template) void runDiff()
  }, [diffFrom, diffTo, open])

  const doRollback = async () => {
    if (!template || !rollbackTarget) return
    setRolling(true)
    const res = await rollbackTemplateVersionAction({ templateId: template.id, targetVersion: rollbackTarget.version })
    setRolling(false)
    if (res.code === 0 && res.data) {
      toast.success(`已回滚至 v${rollbackTarget.version}（当前版本 v${res.data.version}，快照链完整保留）`)
      setRollbackTarget(null)
      // 重新加载版本历史
      setLoading(true)
      const r2 = await listTemplateVersionsAction({ templateId: template.id })
      setLoading(false)
      if (r2.code === 0 && r2.data) setVersions(r2.data.versions)
    } else {
      toast.error(res.msg || "回滚失败")
    }
  }

  const kindBadge = (k: DiffItem["kind"]) => {
    if (k === "ADDED") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">新增</Badge>
    if (k === "REMOVED") return <Badge className="bg-red-100 text-red-700 border-red-200">移除</Badge>
    return <Badge className="bg-amber-100 text-amber-700 border-amber-200">变更</Badge>
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !rolling && onOpenChange(v)}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-teal-600" />
            版本历史「{template?.name}」
          </DialogTitle>
          <DialogDescription>
            每次保存自动存档快照；支持任意两版差异对比（CRX 扩展相关变更紫色高亮）与一键回滚。回滚会产生新版本号，历史链不中断。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 加载版本历史…
          </div>
        ) : versions.length === 0 ? (
          <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
            该模板暂无版本快照（保存一次配置后自动生成）
          </div>
        ) : (
          <div className="space-y-4">
            {/* 差异对比选择器 */}
            <div className="rounded-lg border bg-slate-50 p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium flex items-center gap-1"><Diff className="h-4 w-4" /> 差异对比：</span>
                <Select value={diffFrom} onValueChange={setDiffFrom}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.version} value={String(v.version)}>v{v.version}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground">→</span>
                <Select value={diffTo} onValueChange={setDiffTo}>
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.version} value={String(v.version)}>v{v.version}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={runDiff} disabled={diffLoading || diffFrom === diffTo}>
                  {diffLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
                  重新对比
                </Button>
                {diffItems && (
                  <span className="text-xs text-muted-foreground">
                    {diffItems.length} 处差异{crxCount > 0 ? ` · 含 ${crxCount} 处 CRX 相关` : ""}
                  </span>
                )}
              </div>
              {diffItems && diffItems.length > 0 && (
                <div className="overflow-x-auto rounded-md border bg-white">
                  <table className="w-full text-xs min-w-max">
                    <thead>
                      <tr className="border-b bg-slate-100/60 text-left text-muted-foreground">
                        <th className="px-3 py-2 font-medium">字段</th>
                        <th className="px-3 py-2 font-medium">类型</th>
                        <th className="px-3 py-2 font-medium">旧值（v{diffFrom}）</th>
                        <th className="px-3 py-2 font-medium">新值（v{diffTo}）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffItems.map((it) => (
                        <tr key={it.field} className={`border-b last:border-0 ${it.crxRelated ? "bg-purple-50" : ""}`}>
                          <td className="px-3 py-2 font-mono">
                            {it.field}
                            {it.crxRelated && <Badge className="ml-1 bg-purple-100 text-purple-700 border-purple-200">CRX</Badge>}
                          </td>
                          <td className="px-3 py-2">{kindBadge(it.kind)}</td>
                          <td className="px-3 py-2 font-mono text-red-700 max-w-56 truncate" title={it.before}>{it.before || "（空）"}</td>
                          <td className="px-3 py-2 font-mono text-emerald-700 max-w-56 truncate" title={it.after}>{it.after || "（空）"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 版本列表 */}
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm min-w-max">
                <thead>
                  <tr className="border-b bg-slate-100/60 text-left text-muted-foreground">
                    <th className="px-3 py-2 font-medium">版本</th>
                    <th className="px-3 py-2 font-medium">变更说明</th>
                    <th className="px-3 py-2 font-medium">变更人</th>
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version} className="border-b last:border-0 hover:bg-slate-50/50">
                      <td className="px-3 py-2 font-mono">
                        v{v.version}
                        {template && v.version === template.version && (
                          <Badge className="ml-1 bg-teal-100 text-teal-700 border-teal-200"><CheckCircle2 className="mr-0.5 h-3 w-3" />当前</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-80 truncate" title={v.changeNote || ""}>
                        {v.changeNote || "—"}
                        {v.changedFields.length > 0 && (
                          <span className="ml-1 text-xs text-muted-foreground">（{v.changedFields.join("、")}）</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{v.createdByName || "系统"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{new Date(v.createdAt).toLocaleString("zh-CN")}</td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm" variant="outline"
                          disabled={!canRollback || rolling || (!!template && v.version === template.version)}
                          onClick={() => setRollbackTarget(v)}
                          title={template && v.version === template.version ? "已是当前版本" : canRollback ? `回滚到 v${v.version}` : "无权回滚该模板"}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> 回滚
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 回滚确认 */}
        <Dialog open={!!rollbackTarget} onOpenChange={(v) => !rolling && !v && setRollbackTarget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5 text-amber-600" />
                确认回滚到 v{rollbackTarget?.version}？
              </DialogTitle>
              <DialogDescription>
                模板配置将恢复为 v{rollbackTarget?.version} 的完整快照，同时生成新版本号（历史链完整保留，可继续对比/再回滚）。
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              变更说明：{rollbackTarget?.changeNote || "—"}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRollbackTarget(null)} disabled={rolling}>取消</Button>
              <Button onClick={doRollback} disabled={rolling} className="bg-amber-600 hover:bg-amber-700">
                {rolling ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                确认回滚
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
