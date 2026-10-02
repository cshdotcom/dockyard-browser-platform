"use client"

// ============================================================
// 全局公告层（挂载于 AppShell 顶栏正下方，所有页面生效）：
//   1. 跑马灯 —— 多条合并：第一条滚动 + 「+N」折叠徽章 → Popover 列表 → 点条目开详情
//   2. FORCE_VIEW 强制阅读队列 —— 未读全屏遮罩，必须「我已阅读」
//   3. POPUP 弹窗队列 —— 未读自动弹出；persistAfterRead=true 已读后每次刷新仍弹
//      （除非勾选「今日不再提醒」）
//   4. 详情弹窗 —— MD/HTML 渲染 + 「标为已读」+「今日不再提醒」（allowDismiss 受控）
//   5. 30s 轮询 /api/announcements/visible —— 管理端发布后 ≤30s 全站实时出现
// 会话内去重：sessionStorage 记录本会话已弹出过的公告（刷新页面后按规则重新弹出）
// ============================================================

import * as React from "react"
import { Megaphone, Volume2, ChevronRight, AlertTriangle, CheckCircle2, Loader2, BellOff, Clock3 } from "lucide-react"
import { AnnouncementContent, contentToPlainText } from "@/components/announcements/announcement-content"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

interface VisibleAnnouncement {
  id: string
  title: string
  content: string
  type: string
  displayTypes: string[]
  notifyInbox: boolean
  startAt: string | null
  endAt: string | null
  persistAfterRead: boolean
  allowDismiss: boolean
  read: boolean
  readAt: string | null
  dismissedToday: boolean
  createdAt: string
}

const POPPED_KEY = "dy-ann-popped"

function loadPopped(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    return new Set(JSON.parse(sessionStorage.getItem(POPPED_KEY) || "[]") as string[])
  } catch {
    return new Set()
  }
}

function savePopped(s: Set<string>) {
  try {
    sessionStorage.setItem(POPPED_KEY, JSON.stringify([...s]))
  } catch { /* ignore */ }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function GlobalAnnouncer() {
  const [items, setItems] = React.useState<VisibleAnnouncement[]>([])
  const [popped, setPopped] = React.useState<Set<string>>(() => loadPopped())
  // 会话内关闭集合：persistAfterRead 公告关闭后本轮会话不再弹（刷新页面后重新弹出，符合“已读后仍持续显示”）
  const [sessionHidden, setSessionHidden] = React.useState<Set<string>>(new Set())
  // 详情弹窗（跑马灯/折叠列表/站内信点击打开）
  const [detailId, setDetailId] = React.useState<string | null>(null)
  const [detailDismiss, setDetailDismiss] = React.useState(false)
  const [marking, setMarking] = React.useState(false)
  const [listOpen, setListOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/announcements/visible")
      if (!res.ok) return
      const json = await res.json()
      if (json.code === 0) setItems((json.data.items || []) as VisibleAnnouncement[])
    } catch { /* 静默：公告层不干扰页面 */ }
  }, [])

  React.useEffect(() => {
    void load()
    const t = setInterval(load, 30_000) // 发布后 ≤30s 全站实时出现
    const onFocus = () => void load() // 切回标签页立即刷新（提升实时性）
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener("focus", onFocus)
    }
  }, [load])

  const markPopped = (id: string) => {
    setPopped((prev) => {
      const next = new Set(prev).add(id)
      savePopped(next)
      return next
    })
    // 会话内隐藏（persistAfterRead 的公告关闭后不再重弹，直到刷新）
    setSessionHidden((prev) => new Set(prev).add(id))
  }

  // 标已读 / 今日不再提醒
  const post = async (action: "read" | "dismiss", id: string): Promise<boolean> => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
    try {
      const res = await fetch("/api/announcements/visible", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id, today: todayStr }),
      })
      const json = await res.json()
      if (json.code !== 0) {
        return false
      }
      setItems((prev) =>
        prev.map((a) =>
          a.id === id
            ? action === "read"
              ? { ...a, read: true, readAt: new Date().toISOString() }
              : { ...a, dismissedToday: true }
            : a,
        ),
      )
      return true
    } catch {
      return false
    }
  }

  const inChannel = (a: VisibleAnnouncement, d: string) => a.displayTypes.includes(d)

  // ---- 跑马灯：MARQUEE 通道 + 未「今日不再提醒」（已读与否都持续滚动）----
  const marqueeRows = items.filter((a) => inChannel(a, "MARQUEE") && !a.dismissedToday)

  // ---- 强制阅读队列：FORCE_VIEW && !read && !dismissedToday && 本会话未处理 ----
  // persistAfterRead=true 时无视会话去重（每次刷新/新会话都重新弹出，除非今日不再提醒）
  const forceQueue = items
    .filter((a) => inChannel(a, "FORCE_VIEW") && !a.dismissedToday && !sessionHidden.has(a.id) && (!a.read || a.persistAfterRead) && (a.persistAfterRead || !popped.has(a.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // ---- 弹窗队列：POPUP && !dismissedToday && (未读 || persistAfterRead) && 本会话未弹出 ----
  // persistAfterRead=true 时无视会话去重（每次刷新仍弹，除非勾选今日不再提醒）
  const popupQueue = items
    .filter((a) => inChannel(a, "POPUP") && !a.dismissedToday && !sessionHidden.has(a.id) && (!a.read || a.persistAfterRead) && (a.persistAfterRead || !popped.has(a.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const currentForce = forceQueue[0] || null
  const currentPopup = currentForce ? null : popupQueue[0] || null

  // 详情弹窗目标（跑马灯/列表点击）
  const detail = detailId ? items.find((a) => a.id === detailId) || null : null

  const confirmForce = async () => {
    if (!currentForce) return
    setMarking(true)
    const ok = await post("read", currentForce.id)
    setMarking(false)
    if (ok || currentForce.read) markPopped(currentForce.id)
    else markPopped(currentForce.id) // 标记失败也出队，避免死循环遮挡（下轮轮询会恢复）
  }

  const confirmPopup = () => {
    if (!currentPopup) return
    // POPUP：未读 → 确认即写已读；已读（persistAfterRead 持续显示）→ 仅关闭本轮
    if (!currentPopup.read) {
      void post("read", currentPopup.id)
    }
    markPopped(currentPopup.id)
  }

  const submitDetail = async () => {
    if (!detail) return
    setMarking(true)
    try {
      if (!detail.read) {
        const ok = await post("read", detail.id)
        if (!ok) return
      }
      if (detailDismiss) {
        await post("dismiss", detail.id)
      }
      setDetailId(null)
      setDetailDismiss(false)
    } finally {
      setMarking(false)
    }
  }

  const marqueeText = marqueeRows.map((a) => `【${a.title}】${contentToPlainText(a.content, 80)}`).join("　　◆　　")

  return (
    <>
      {/* ---- 跑马灯（顶栏正下方，所有页面）—— 多条合并：首条滚动 + +N 折叠 ---- */}
      {marqueeRows.length > 0 && (
        <div className="relative overflow-hidden border-b border-teal-200 dark:border-teal-900 bg-teal-50/80 dark:bg-teal-950/40">
          <div className="absolute left-0 top-0 bottom-0 z-10 flex items-center gap-1.5 bg-teal-600 text-white px-3 text-xs font-medium shrink-0">
            <Volume2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">公告</span>
          </div>
          <button
            type="button"
            className="block w-full text-left cursor-pointer"
            onClick={() => setDetailId(marqueeRows[0].id)}
            aria-label={`查看公告：${marqueeRows[0].title}`}
          >
            <div className="marquee-track py-1.5 pl-24 pr-28 whitespace-nowrap text-[13px] text-teal-800 dark:text-teal-300">
              {marqueeText}
            </div>
          </button>
          {/* 多条合并折叠徽章：+N 展开公告列表 */}
          {marqueeRows.length > 1 && (
            <Popover open={listOpen} onOpenChange={setListOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="absolute right-2 top-0 bottom-0 z-10 flex items-center gap-0.5 px-2 rounded bg-teal-600/90 text-white text-xs font-medium hover:bg-teal-700"
                  aria-label={`还有 ${marqueeRows.length - 1} 条公告`}
                >
                  <span>+{marqueeRows.length - 1}</span>
                  <ChevronRight className="h-3 w-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="px-3 py-2 border-b text-xs font-medium flex items-center gap-1.5">
                  <Megaphone className="h-3.5 w-3.5 text-teal-600" />
                  当前滚动公告（{marqueeRows.length} 条）
                </div>
                <ScrollArea className="max-h-64">
                  <div className="divide-y">
                    {marqueeRows.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="w-full text-left px-3 py-2.5 hover:bg-muted/60 transition"
                        onClick={() => {
                          setListOpen(false)
                          setDetailId(a.id)
                        }}
                      >
                        <p className="text-sm font-medium truncate">{a.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {contentToPlainText(a.content, 60)}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {fmtTime(a.createdAt)}
                          {!a.read && <span className="ml-1.5 text-orange-500">未读</span>}
                        </p>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
          )}
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

      {/* ---- FORCE_VIEW 全屏遮罩（未读必须确认；所有页面生效） ---- */}
      {currentForce && (
        <div
          className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label={currentForce.title}
        >
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg border-2 border-teal-600 bg-card shadow-2xl">
            <div className="flex items-center gap-2 border-b px-5 py-3.5">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <p className="text-lg font-semibold">重要公告 · 需要确认阅读</p>
            </div>
            <ScrollArea className="flex-1 overflow-hidden px-5 py-4">
              <h2 className="text-xl font-semibold mb-3">{currentForce.title}</h2>
              <AnnouncementContent content={currentForce.content} />
            </ScrollArea>
            <div className="border-t p-4 flex flex-col sm:flex-row items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {forceQueue.length > 1 ? `还有 ${forceQueue.length - 1} 条重要公告待阅读` : "阅读确认后不再重复弹出"}
              </p>
              <Button size="lg" onClick={confirmForce} disabled={marking} className="bg-teal-600 hover:bg-teal-700 w-full sm:w-auto">
                {marking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                我已阅读
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- POPUP 弹窗队列（所有页面；已读且 persistAfterRead 的每次刷新仍弹） ---- */}
      {currentPopup && (
        <Dialog open onOpenChange={() => { /* POPUP 引导确认阅读，不允许点遮罩关闭 */ }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Megaphone className="h-5 w-5 text-teal-600" />
                {currentPopup.title}
              </DialogTitle>
              <DialogDescription className="flex items-center gap-2 flex-wrap">
                <span>发布于 {fmtTime(currentPopup.createdAt)}</span>
                {currentPopup.read && currentPopup.persistAfterRead && (
                  <Badge variant="secondary" className="text-[10px]">持续显示</Badge>
                )}
              </DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-72 pr-3">
              <AnnouncementContent content={currentPopup.content} />
            </ScrollArea>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              {currentPopup.allowDismiss && (
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer mr-auto select-none">
                  <Checkbox checked={false} onCheckedChange={() => void post("dismiss", currentPopup.id).then((ok) => { if (ok) confirmPopup() })} />
                  今日不再提醒
                </label>
              )}
              <Button onClick={confirmPopup} className="bg-teal-600 hover:bg-teal-700">
                {currentPopup.read ? "知道了" : "知道了（标为已读）"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ---- 详情弹窗（跑马灯/折叠列表点击打开；含已读按钮 + 今日不再提醒） ---- */}
      <Dialog open={!!detail} onOpenChange={(v) => { if (!v) { setDetailId(null); setDetailDismiss(false) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="h-5 w-5 text-teal-600 shrink-0" />
              <span className="truncate">{detail?.title}</span>
            </DialogTitle>
            <DialogDescription className="flex items-center gap-2 flex-wrap">
              <span>发布于 {detail ? fmtTime(detail.createdAt) : ""}</span>
              {detail?.endAt && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 className="h-3 w-3" /> 截止 {fmtTime(detail.endAt)}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] pr-3">
            <AnnouncementContent content={detail?.content || ""} />
          </ScrollArea>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            {detail?.allowDismiss && (
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer mr-auto select-none">
                <Checkbox
                  checked={detailDismiss || detail.dismissedToday}
                  disabled={detail.dismissedToday}
                  onCheckedChange={(v) => setDetailDismiss(!!v)}
                />
                {detail.dismissedToday ? "今日已不再提醒" : "今日不再提醒"}
              </label>
            )}
            {detail && (detail.read ? (
              <Badge variant="outline" className="gap-1 text-xs py-1.5 px-3">
                <CheckCircle2 className="h-3.5 w-3.5 text-teal-600" />
                {detail.readAt ? `已读于 ${fmtTime(detail.readAt)}` : "已读"}
              </Badge>
            ) : (
              <Button onClick={submitDetail} disabled={marking} className="bg-teal-600 hover:bg-teal-700">
                {marking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                已读
              </Button>
            ))}
            <Button variant="outline" onClick={() => { setDetailId(null); setDetailDismiss(false) }}>
              <BellOff className="mr-1 h-3.5 w-3.5" /> 关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
