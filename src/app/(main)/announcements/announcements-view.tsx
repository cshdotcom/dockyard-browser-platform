"use client"

// ============================================================
// 公告列表视图（用户端 /announcements）r22 重构：
//   1. 关键词搜索 —— 标题 + 正文纯文本（客户端过滤，实时生效）
//   2. 列表卡片点击 → 公告详情弹窗（完整 MD/HTML 渲染）
//      内容区 max-h + overflow-y-auto：长公告滚动阅读，不溢出不错乱
//   3. ?focus=<id> 定位 —— 站内信「查看详情」落地：自动打开详情弹窗
//      + 卡片高亮 + 滚动到可见
//   4. 标为已读（markAnnouncementReadAction）→ 本地即时更新 + RSC 刷新
// 注：跑马灯 / 强制阅读 / 弹窗队列由 GlobalAnnouncer 全局层统一呈现
//     （所有页面顶栏正下方），本页不再重复渲染，避免双弹窗/双跑马灯
// ============================================================

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BellRing, CheckCircle2, Globe2, Loader2, Megaphone, Search, Users, User as UserIcon, X } from "lucide-react"
import { AnnouncementContent, AnnouncementSummary, contentToPlainText } from "@/components/announcements/announcement-content"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { markAnnouncementReadAction } from "@/server/actions/profile"

export interface AnnouncementRow {
  id: string
  title: string
  content: string
  type: string
  typeLabel: string
  displayType: string
  displayLabel: string
  displayTypes: string[] // 多选发布通道
  notifyInbox: boolean // 站内信通道
  read: boolean
  createdAt: string
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  GLOBAL: <Globe2 className="h-3.5 w-3.5" />,
  GROUP: <Users className="h-3.5 w-3.5" />,
  USER: <UserIcon className="h-3.5 w-3.5" />,
}

const TYPE_BADGE: Record<string, string> = {
  GLOBAL: "bg-violet-600 hover:bg-violet-600",
  GROUP: "bg-amber-500 hover:bg-amber-500",
  USER: "bg-teal-600 hover:bg-teal-600",
}

const DISPLAY_LABEL: Record<string, string> = { POPUP: "弹窗", MARQUEE: "跑马灯", FORCE_VIEW: "强制阅读" }

export function AnnouncementsView({ rows, focusId }: { rows: AnnouncementRow[]; focusId?: string }) {
  const router = useRouter()

  // ---- 搜索：标题 + 正文纯文本（客户端实时过滤）----
  const [keyword, setKeyword] = React.useState("")

  // 本地已读集合（mark 成功后即时更新 UI）
  const [localRead, setLocalRead] = React.useState<Set<string>>(new Set())
  const isRead = (r: AnnouncementRow) => r.read || localRead.has(r.id)

  // 详情弹窗目标（卡片点击 / focus 定位打开）
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [marking, setMarking] = React.useState(false)

  // ---- focus 定位：进入页面自动打开详情弹窗 + 卡片滚动到可见 ----
  React.useEffect(() => {
    if (!focusId) return
    if (rows.some((r) => r.id === focusId)) {
      setDetailId(focusId)
      // 等待渲染后滚动定位
      const t = setTimeout(() => {
        document.getElementById(`ann-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
      }, 150)
      return () => clearTimeout(t)
    }
  }, [focusId, rows])

  // ---- 搜索索引（正文剥 MD/HTML 语法后参与匹配）----
  const searchIndex = React.useMemo(
    () => rows.map((r) => ({
      id: r.id,
      text: `${r.title}\n${contentToPlainText(r.content, 10000)}`.toLowerCase(),
    })),
    [rows],
  )

  const filtered = React.useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return rows
    return rows.filter((r) => searchIndex.find((x) => x.id === r.id)?.text.includes(kw) ?? false)
  }, [keyword, rows, searchIndex])

  // 标记已读：action 成功后本地更新 + 重新拉取 RSC 数据
  const markRead = async (ann: AnnouncementRow): Promise<boolean> => {
    setMarking(true)
    try {
      const res = await markAnnouncementReadAction({ announcementId: ann.id })
      if (res.code !== 0) {
        toast.error(res.msg)
        return false
      }
      setLocalRead((prev) => new Set(prev).add(ann.id))
      router.refresh()
      return true
    } finally {
      setMarking(false)
    }
  }

  const detail = detailId ? rows.find((r) => r.id === detailId) || null : null
  const kwTrim = keyword.trim()

  return (
    <div className="space-y-4">
      {/* ---- 搜索栏：标题 + 正文关键词 ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-56 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索公告标题 / 内容关键词"
            className="pl-8 pr-8"
            aria-label="搜索公告"
          />
          {keyword && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setKeyword("")}
              aria-label="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground ml-auto shrink-0">
          {kwTrim ? `匹配 ${filtered.length} / ${rows.length} 条` : `共 ${rows.length} 条公告`}
        </p>
      </div>

      {/* ---- 公告列表（卡片点击打开详情弹窗） ---- */}
      {filtered.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {kwTrim ? `未找到匹配「${kwTrim}」的公告` : "暂无可见公告"}
          </CardContent>
        </Card>
      )}
      <div className="space-y-3">
        {filtered.map((r) => (
          <Card
            key={r.id}
            id={`ann-${r.id}`}
            role="button"
            tabIndex={0}
            aria-label={`查看公告详情：${r.title}`}
            className={cn(
              "cursor-pointer transition-all hover:border-teal-400 dark:hover:border-teal-700 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500",
              !isRead(r) && "border-teal-400 dark:border-teal-700",
              focusId === r.id && "ring-2 ring-teal-400 dark:ring-teal-600",
            )}
            onClick={() => setDetailId(r.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                setDetailId(r.id)
              }
            }}
          >
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    <span className="truncate">{r.title}</span>
                    {!isRead(r) && <Badge className="bg-orange-500 hover:bg-orange-500 text-[10px] shrink-0">未读</Badge>}
                  </CardTitle>
                  <CardDescription className="mt-1 flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] gap-1 font-normal">
                      {TYPE_ICON[r.type]} {r.typeLabel}
                    </Badge>
                    {(r.displayTypes?.length ? r.displayTypes : [r.displayType]).map((d) => (
                      <Badge key={d} variant="secondary" className="text-[10px] font-normal">{DISPLAY_LABEL[d] || d}</Badge>
                    ))}
                    {r.notifyInbox && (
                      <Badge variant="secondary" className="text-[10px] font-normal gap-1">
                        <BellRing className="h-2.5 w-2.5 text-violet-500" />站内信
                      </Badge>
                    )}
                    <span>{r.createdAt}</span>
                  </CardDescription>
                </div>
                {!isRead(r) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      void markRead(r)
                    }}
                    disabled={marking}
                    className="text-teal-600 hover:text-teal-700 shrink-0"
                  >
                    {marking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                    标为已读
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="pb-4 pt-0">
              <p className="text-sm text-muted-foreground line-clamp-2">
                <AnnouncementSummary content={r.content} maxLen={160} />
              </p>
              <p className="mt-1.5 text-xs text-teal-600">点击查看详情 →</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ---- 公告详情弹窗：完整 MD/HTML 渲染 + 限高滚动（长内容不溢出） ---- */}
      <Dialog open={!!detail} onOpenChange={(v) => { if (!v) setDetailId(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <Megaphone className="h-5 w-5 text-teal-600 shrink-0" />
              <span className="truncate">{detail?.title}</span>
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 flex-wrap">
              {detail && (
                <>
                  <Badge variant="outline" className="text-[10px] gap-1 font-normal">
                    {TYPE_ICON[detail.type]} {detail.typeLabel}
                  </Badge>
                  {(detail.displayTypes?.length ? detail.displayTypes : [detail.displayType]).map((d) => (
                    <Badge key={d} variant="secondary" className="text-[10px] font-normal">{DISPLAY_LABEL[d] || d}</Badge>
                  ))}
                  <span>发布于 {detail.createdAt}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] rounded-md border px-3 py-2">
            <AnnouncementContent content={detail?.content || ""} />
          </ScrollArea>
          <DialogFooter className="flex-col sm:flex-row gap-2 sm:justify-between">
            <div className="min-w-0">
              {detail && (isRead(detail) ? (
                <Badge variant="outline" className="gap-1 text-xs py-1.5 px-3">
                  <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />
                  已读
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-teal-600" /> 该公告尚未阅读
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {detail && !isRead(detail) && (
                <Button onClick={() => void markRead(detail)} disabled={marking} className="bg-teal-600 hover:bg-teal-700">
                  {marking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                  标为已读
                </Button>
              )}
              <Button variant="outline" onClick={() => setDetailId(null)}>
                关闭
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
