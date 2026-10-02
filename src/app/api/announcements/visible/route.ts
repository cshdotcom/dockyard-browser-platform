import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext, userGroupIds } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// ============================================================
// 全局公告层 API（所有登录用户）：
//   GET  /api/announcements/visible —— 当前用户可见公告（含已读/今日不再提醒状态）
//        · 目标过滤：GLOBAL 全站 / GROUP=我的组 / USER=定向我
//        · 时效过滤：enabled + startAt<=now + (endAt null 或 >now)
//        · 30s 轮询：管理端发布后 ≤30s 内全站所有页面实时出现（跑马灯/弹窗）
//   POST /api/announcements/visible —— { action: "read" | "dismiss", id, today? }
//        · read    → AnnouncementRead upsert（详情页「已读」按钮）
//        · dismiss → AnnouncementDismiss upsert（「今日不再提醒」，管理员 allowDismiss=true 才可用）
//          today 为客户端本地日期 yyyy-MM-DD（今日不再提醒按用户本地日历日计算）
// ============================================================

const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/

function localDateString(d: Date): string {
  // 服务器本地时区兜底日期（客户端未传 today 时使用）
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })

    const now = new Date()
    const gids = await userGroupIds(ctx.userId)

    // 可见目标 + 启用 + 时间窗（startAt 未到不展示；endAt 过期不展示）
    const anns = await db.announcement.findMany({
      where: {
        enabled: true,
        AND: [
          { OR: [{ type: "GLOBAL" }, { type: "GROUP", groupId: { in: gids } }, { type: "USER", userId: ctx.userId }] },
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gt: now } }] },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    })

    const ids = anns.map((a) => a.id)
    const [reads, dismisses] = ids.length
      ? await Promise.all([
          db.announcementRead.findMany({ where: { userId: ctx.userId, announcementId: { in: ids } }, select: { announcementId: true, readAt: true } }),
          db.announcementDismiss.findMany({ where: { userId: ctx.userId, announcementId: { in: ids }, dismissDate: localDateString(now) }, select: { announcementId: true } }),
        ])
      : [[], []]
    const readMap = new Map(reads.map((r) => [r.announcementId, r.readAt]))
    const dismissSet = new Set(dismisses.map((d) => d.announcementId))

    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        serverTime: now.toISOString(),
        items: anns.map((a) => ({
          id: a.id,
          title: a.title,
          content: a.content,
          type: a.type,
          displayTypes: a.displayTypes ? (JSON.parse(a.displayTypes) as string[]) : [a.displayType],
          notifyInbox: a.notifyInbox,
          startAt: a.startAt?.toISOString() ?? null,
          endAt: a.endAt?.toISOString() ?? null,
          persistAfterRead: a.persistAfterRead,
          allowDismiss: a.allowDismiss,
          read: readMap.has(a.id),
          readAt: readMap.get(a.id)?.toISOString() ?? null,
          dismissedToday: dismissSet.has(a.id),
          createdAt: a.createdAt.toISOString(),
        })),
      },
    })
  })
}

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })

    let body: { action?: string; id?: string; today?: string } = {}
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ code: 40001, msg: "请求体格式错误" })
    }
    const { action, id } = body
    if (!id || (action !== "read" && action !== "dismiss")) {
      return NextResponse.json({ code: 40001, msg: "参数错误（action=read|dismiss, id 必填）" })
    }

    const ann = await db.announcement.findUnique({ where: { id } })
    if (!ann || !ann.enabled) return NextResponse.json({ code: 40401, msg: "公告不存在或已停用" })

    // 可见性校验（防越权标记他人定向公告）
    if (ann.type === "GROUP") {
      const gids = await userGroupIds(ctx.userId)
      if (!ann.groupId || !gids.includes(ann.groupId)) return NextResponse.json({ code: 40301, msg: "无权操作该公告" })
    } else if (ann.type === "USER" && ann.userId !== ctx.userId) {
      return NextResponse.json({ code: 40301, msg: "无权操作该公告" })
    }

    if (action === "read") {
      await db.announcementRead.upsert({
        where: { announcementId_userId: { announcementId: ann.id, userId: ctx.userId } },
        update: {},
        create: { announcementId: ann.id, userId: ctx.userId },
      })
      return NextResponse.json({ code: 0, msg: "已标记已读", data: { id: ann.id, read: true } })
    }

    // 今日不再提醒（管理员 allowDismiss=false 时拒绝）
    if (!ann.allowDismiss) return NextResponse.json({ code: 40301, msg: "管理员未开放「今日不再提醒」" })
    const today = body.today && TODAY_RE.test(body.today) ? body.today : localDateString(new Date())
    await db.announcementDismiss.upsert({
      where: { announcementId_userId_dismissDate: { announcementId: ann.id, userId: ctx.userId, dismissDate: today } },
      update: {},
      create: { announcementId: ann.id, userId: ctx.userId, dismissDate: today },
    })
    return NextResponse.json({ code: 0, msg: "今日不再提醒", data: { id: ann.id, dismissedToday: true } })
  })
}
