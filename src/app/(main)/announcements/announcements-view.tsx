"use client"

// 公告展示组件：
// 1. MARQUEE 跑马灯 —— 页面顶部横向滚动条（CSS animation）
// 2. FORCE_VIEW 强制阅读 —— 全屏遮罩，必须点击"我已阅读"才能关闭
// 3. POPUP 弹窗 —— 页面加载时未读的自动弹出，确认后写已读记录
// 4. 列表卡片 —— 全部可见公告（标题 / markdown 纯文本内容 / 发布时间 / 已读状态）

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, CheckCircle2, Globe2, Loader2, Megaphone, Users, User as UserIcon, Volume2, BellRing } from "lucide-react"
import { AnnouncementContent, contentToPlainText } from "@/components/announcements/announcement-content"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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

export function AnnouncementsView({ rows }: { rows: AnnouncementRow[] }) {
  const router = useRouter()

  // 本地已读集合（mark 成功后即时更新 UI）
  const [localRead, setLocalRead] = React.useState<Set<string>>(new Set())
  const isRead = (r: AnnouncementRow) => r.read || localRead.has(r.id)

  // 跑马灯公告（多选通道：displayTypes 含 MARQUEE 即滚动）
  const marqueeRows = rows.filter((r) => (r.displayTypes?.length ? r.displayTypes : [r.displayType]).includes("MARQUEE"))
  const marqueeText = marqueeRows.map((r) => `【${r.title}】${contentToPlainText(r.content, 80)}`).join("　　◆　　")

  // 强制阅读队列：未读的 FORCE_VIEW 按发布时间从旧到新逐条展示（多选通道任含即生效）
  const inChannels = (r: AnnouncementRow, d: string) => (r.displayTypes?.length ? r.displayTypes : [r.displayType]).includes(d)
  const [forceQueue, setForceQueue] = React.useState<AnnouncementRow[]>(() =>
    rows
      .filter((r) => inChannels(r, "FORCE_VIEW") && !isRead(r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  )
  // 弹窗队列：未读的 POPUP（强制阅读处理完后依次弹出）
  const [popupQueue, setPopupQueue] = React.useState<AnnouncementRow[]>(() =>
    rows.filter((r) => inChannels(r, "POPUP") && !isRead(r))
  )

  const [marking, setMarking] = React.useState(false)

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

  const confirmForce = async () => {
    const current = forceQueue[0]
    if (!current) return
    const ok = await markRead(current)
    if (ok) setForceQueue((q) => q.slice(1))
  }

  const confirmPopup = async () => {
    const current = popupQueue[0]
    if (!current) return
    const ok = await markRead(current)
    if (ok) setPopupQueue((q) => q.slice(1))
  }

  const currentForce = forceQueue[0] || null
  const currentPopup = popupQueue[0] || null

  return (
    <div className="space-y-6">
      {/* ---- 跑马灯 ---- */}
      {marqueeText && (
        <div className="relative overflow-hidden rounded-lg border border-teal-300 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40">
          <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center gap-1.5 bg-teal-600 text-white px-3 text-xs font-medium shrink-0">
            <Volume2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">滚动公告</span>
          </div>
          <div className="marquee-track py-2 pl-28 pr-4 whitespace-nowrap text-sm text-teal-800 dark:text-teal-300">
            {marqueeText}
          </div>
          {/* CSS 动画（本地注入，避免修改全局样式） */}
          <style>{`
            .marquee-track {
              display: inline-block;
              animation: dy-marquee 30s linear infinite;
            }
            .marquee-track:hover { animation-play-state: paused; }
            @keyframes dy-marquee {
              0% { transform: translateX(0); }
              100% { transform: translateX(-100%); }
            }
          `}</style>
        </div>
      )}

      {/* ---- FORCE_VIEW 全屏遮罩（必须点击"我已阅读"） ---- */}
      {currentForce && (
        <div
          className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label={currentForce.title}
        >
          <Card className="w-full max-w-2xl max-h-[85vh] flex flex-col border-2 border-teal-600 shadow-2xl">
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                重要公告 · 需要确认阅读
              </CardTitle>
              <CardDescription className="flex items-center gap-2 flex-wrap">
                <Badge className={TYPE_BADGE[currentForce.type]}>
                  {TYPE_ICON[currentForce.type]} {currentForce.typeLabel}
                </Badge>
                <span>发布于 {currentForce.createdAt}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden py-4">
              <ScrollArea className="h-full max-h-[52vh] pr-3">
                <h2 className="text-xl font-semibold mb-3">{currentForce.title}</h2>
                <AnnouncementContent content={currentForce.content} />
              </ScrollArea>
            </CardContent>
            <div className="border-t p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {forceQueue.length > 1 ? `还有 ${forceQueue.length - 1} 条重要公告待阅读` : "阅读确认后不再重复弹出"}
              </p>
              <Button
                size="lg"
                onClick={confirmForce}
                disabled={marking}
                className="bg-teal-600 hover:bg-teal-700 w-full sm:w-auto"
              >
                {marking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                我已阅读
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* ---- POPUP 弹窗（未读自动弹出，确认后写已读） ---- */}
      <Dialog
        open={!!currentPopup}
        onOpenChange={() => {
          // POPUP 不允许点遮罩直接关闭，引导确认阅读
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="h-5 w-5 text-teal-600" />
              {currentPopup?.title}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2">
              {currentPopup && (
                <>
                  <Badge className={TYPE_BADGE[currentPopup.type]}>
                    {TYPE_ICON[currentPopup.type]} {currentPopup.typeLabel}
                  </Badge>
                  <span>发布于 {currentPopup.createdAt}</span>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-72 pr-3">
            <AnnouncementContent content={currentPopup?.content || ""} />
          </ScrollArea>
          <DialogFooter>
            <Button onClick={confirmPopup} disabled={marking} className="bg-teal-600 hover:bg-teal-700">
              {marking && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 公告列表卡片 ---- */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold">全部公告</h2>
        {rows.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              暂无可见公告
            </CardContent>
          </Card>
        )}
        {rows.map((r) => (
          <Card key={r.id} className={cn("transition-colors", !isRead(r) && "border-teal-400 dark:border-teal-700")}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    {r.title}
                    {!isRead(r) && <Badge className="bg-orange-500 hover:bg-orange-500 text-[10px]">未读</Badge>}
                  </CardTitle>
                  <CardDescription className="mt-1 flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] gap-1 font-normal">
                      {TYPE_ICON[r.type]} {r.typeLabel}
                    </Badge>
                    {(r.displayTypes?.length ? r.displayTypes : [r.displayType]).map((d) => (
                      <Badge key={d} variant="secondary" className="text-[10px] font-normal">{r.displayLabel || d}</Badge>
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
                    onClick={() => markRead(r)}
                    disabled={marking}
                    className="text-teal-600 hover:text-teal-700 shrink-0"
                  >
                    {marking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                    标为已读
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <AnnouncementContent content={r.content} className="text-muted-foreground" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
