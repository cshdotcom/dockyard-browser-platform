"use client"

// ============================================================
// 我的分享管理面板（r28a 用户云盘 · 页内折叠区）
//   · listMyFileSharesAction 列表（我创建的全部分享，含已撤销/已过期）
//   · 名称 / 类型 / 密钥有无 / 过期 / 状态 / 次数 / 查看·下载计数 / URL 复制 / 撤销
//   · version 属性变更（新建分享后）自动重新拉取
// ============================================================

import * as React from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ConfirmDialog } from "@/components/shared/confirm"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, Copy, ExternalLink, Loader2, RefreshCw, Share2, Ban, KeyRound } from "lucide-react"
import { listMyFileSharesAction, revokeFileShareAction } from "@/server/actions/files"
import type { MyShareRow } from "./types"

interface MySharesPanelProps {
  /** 外部事件计数（新建分享 → +1 → 自动刷新列表） */
  version: number
}

export function MySharesPanel({ version }: MySharesPanelProps) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [items, setItems] = React.useState<MyShareRow[] | null>(null)
  const [revokeTarget, setRevokeTarget] = React.useState<MyShareRow | null>(null)
  const [revoking, setRevoking] = React.useState(false)
  const [kw, setKw] = React.useState("")
  const loadedOnceRef = React.useRef(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await listMyFileSharesAction({})
      if (res.code === 0 && res.data) {
        setItems(res.data.items as unknown as MyShareRow[])
      } else {
        toast.error(res.msg || "分享列表加载失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "分享列表加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次展开加载；version 变更后刷新
  React.useEffect(() => {
    if (open && !loadedOnceRef.current) {
      loadedOnceRef.current = true
      void load()
    }
  }, [open, load])

  React.useEffect(() => {
    if (version > 0 && loadedOnceRef.current) void load(true)
  }, [version, load])

  const filtered = React.useMemo(() => {
    if (!items) return []
    if (!kw.trim()) return items
    const q = kw.trim().toLowerCase()
    return items.filter((s) => s.name.toLowerCase().includes(q) || s.token.toLowerCase().includes(q))
  }, [items, kw])

  const copyUrl = async (s: MyShareRow) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${s.url}`)
      toast.success("分享链接已复制")
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  const doRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      const res = await revokeFileShareAction({ token: revokeTarget.token })
      if (res.code === 0) {
        toast.success(`已撤销分享「${revokeTarget.name}」`)
        void load(true)
      } else {
        toast.error(res.msg || "撤销失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "撤销失败")
    } finally {
      setRevoking(false)
      setRevokeTarget(null)
    }
  }

  const statusBadge = (s: MyShareRow) => {
    if (s.revoked) return <Badge variant="outline">已撤销</Badge>
    if (s.expired) return <Badge variant="destructive">已过期</Badge>
    if (s.maxUses > 0 && s.useCount >= s.maxUses) return <Badge variant="destructive">次数用尽</Badge>
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">有效</Badge>
  }

  return (
    <div className="rounded-lg border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 p-3 flex-wrap">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="font-medium">
              {open ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronRight className="mr-1 h-4 w-4" />}
              <Share2 className="mr-1.5 h-4 w-4 text-teal-600" />
              我的分享管理
              {items && <Badge variant="secondary" className="ml-1.5">{items.length}</Badge>}
            </Button>
          </CollapsibleTrigger>
          {open && (
            <>
              <Input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder="搜索分享名称 / token…"
                className="w-52 h-8"
              />
              <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} title="刷新列表">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            公开分享 token 32 字节随机不可枚举 · 过期/撤销/超次自动失效
          </span>
        </div>
        <CollapsibleContent>
          <div className="border-t">
            {loading && !items ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 加载分享列表…
              </div>
            ) : !items || filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {items && items.length > 0 && kw ? "没有匹配的分享" : "暂无分享 —— 选择文件后点击「批量分享」创建"}
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0">
                    <TableRow className="hover:bg-transparent [&_th]:bg-card">
                      <TableHead>名称</TableHead>
                      <TableHead className="w-24">类型</TableHead>
                      <TableHead className="w-16">密钥</TableHead>
                      <TableHead className="w-40">有效期</TableHead>
                      <TableHead className="w-20">状态</TableHead>
                      <TableHead className="w-24">次数</TableHead>
                      <TableHead className="w-28">查看 / 下载</TableHead>
                      <TableHead className="w-28 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-52" title={s.name}>{s.name}</p>
                          <p className="text-[10px] text-muted-foreground font-mono truncate max-w-52">{s.token}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="text-[10px]">
                            {s.isFolder ? "文件夹" : s.fileCount != null && s.fileCount > 1 ? `${s.fileCount} 文件` : "单文件"}
                          </Badge>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{s.permission === "DOWNLOAD" ? "可下载" : "仅预览"}</p>
                        </TableCell>
                        <TableCell>
                          {s.hasKey ? (
                            <span title="受密钥保护">
                              <KeyRound className="h-3.5 w-3.5 text-amber-600" />
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">无</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={`text-xs tabular-nums ${s.expired && !s.revoked ? "text-red-600" : ""}`}>
                            {s.expireAt ? new Date(s.expireAt).toLocaleString("zh-CN") : "永久"}
                          </span>
                        </TableCell>
                        <TableCell>{statusBadge(s)}</TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {s.useCount}/{s.maxUses > 0 ? s.maxUses : "∞"}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {s.viewCount} / {s.downloadCount}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button variant="ghost" size="sm" onClick={() => void copyUrl(s)} aria-label="复制链接" title="复制链接">
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" asChild title="打开分享页">
                              <a href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`打开分享 ${s.name}`}>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </Button>
                            {!s.revoked && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-600"
                                onClick={() => setRevokeTarget(s)}
                                aria-label="撤销分享"
                                title="撤销分享"
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(v) => !v && setRevokeTarget(null)}
        title="撤销该分享"
        description={`确认撤销「${revokeTarget?.name}」？\n撤销后公开链接立即失效（访客统一提示"分享不存在"，不泄露细节）；该操作不可恢复，如需再次分享请重新创建。`}
        confirmText="确认撤销"
        destructive
        loading={revoking}
        onConfirm={async () => {
          await doRevoke()
        }}
      />
    </div>
  )
}
