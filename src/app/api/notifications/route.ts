import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { apiHandler } from "@/lib/api"

// 站内通知（r28 增强）：
//   GET    /api/notifications?limit=30&filter=all|unread|cleared   列表+未读数（默认排除已清除）
//   PATCH  { id }          单条标记已读（归属校验）
//   PUT                     全部已读
//   DELETE { mode: "one"|"read"|"all", id? }   通知清除（软删除；用户本人）
//   POST   { userId, title, content, link? }   管理员向指定用户发送通知
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 30)))
    const filter = req.nextUrl.searchParams.get("filter") || "all"
    const where: { userId: string; clearedAt?: null | { not: null } | null; readAt?: null } = { userId: ctx.userId }
    if (filter === "cleared") where.clearedAt = { not: null }
    else where.clearedAt = null // 默认排除已清除
    if (filter === "unread") where.readAt = null
    const items = await db.notice.findMany({ where, orderBy: { createdAt: "desc" }, take: limit })
    const unread = items.filter((i) => !i.readAt).length
    const totalUncleared = await db.notice.count({ where: { userId: ctx.userId, clearedAt: null } })
    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        items: items.map((i) => ({
          id: i.id, title: i.title, content: i.content, type: i.type, link: i.link || null,
          sourceType: i.sourceType || null, sourceKey: i.sourceKey || null,
          readAt: i.readAt?.toISOString() ?? null,
          clearedAt: i.clearedAt?.toISOString() ?? null,
          createdAt: i.createdAt.toISOString(),
        })),
        unread,
        total: totalUncleared,
      },
    })
  })
}

// 单条标记已读：{ id } —— 归属校验（只能操作自己的通知）；已读则幂等返回
export async function PATCH(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    let body: { id?: string } = {}
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ code: 40001, msg: "请求体格式错误" })
    }
    if (!body.id) return NextResponse.json({ code: 40001, msg: "参数错误（id 必填）" })
    const notice = await db.notice.findFirst({ where: { id: body.id, userId: ctx.userId } })
    if (!notice) return NextResponse.json({ code: 40401, msg: "通知不存在" })
    if (notice.readAt) {
      return NextResponse.json({ code: 0, msg: "已是已读状态", data: { id: notice.id, readAt: notice.readAt.toISOString() } })
    }
    const readAt = new Date()
    await db.notice.update({ where: { id: notice.id }, data: { readAt } })
    return NextResponse.json({ code: 0, msg: "已标记已读", data: { id: notice.id, readAt: readAt.toISOString() } })
  })
}

export async function PUT() {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    await db.notice.updateMany({ where: { userId: ctx.userId, readAt: null, clearedAt: null }, data: { readAt: new Date() } })
    return NextResponse.json({ code: 0, msg: "全部已读" })
  })
}

// r28：通知清除（软删除 —— 用户诉求「站内信增加通知清除功能」）
// mode: "one"（单条，id 必填）| "read"（清除全部已读）| "all"（清除全部）| "many"（r33：多选批量，ids 必填）
export async function DELETE(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    const body = (await req.json().catch(() => ({}))) as { mode?: string; id?: string; ids?: string[] }
    const mode = body.mode || "one"
    const now = new Date()
    let affected = 0
    if (mode === "one") {
      if (!body.id) return NextResponse.json({ code: 40001, msg: "参数错误（单条清除需 id）" })
      const r = await db.notice.updateMany({
        where: { id: body.id, userId: ctx.userId, clearedAt: null },
        data: { clearedAt: now, clearedBy: ctx.userId },
      })
      affected = r.count
    } else if (mode === "many") {
      // r33：多选批量清除（单次上限 200 条；归属校验由 where 保证）
      const ids = (body.ids || []).filter((x) => typeof x === "string" && x.length > 0).slice(0, 200)
      if (ids.length === 0) return NextResponse.json({ code: 40001, msg: "参数错误（批量清除需 ids）" })
      const r = await db.notice.updateMany({
        where: { id: { in: ids }, userId: ctx.userId, clearedAt: null },
        data: { clearedAt: now, clearedBy: ctx.userId },
      })
      affected = r.count
    } else if (mode === "read") {
      const r = await db.notice.updateMany({
        where: { userId: ctx.userId, readAt: { not: null }, clearedAt: null },
        data: { clearedAt: now, clearedBy: ctx.userId },
      })
      affected = r.count
    } else if (mode === "all") {
      const r = await db.notice.updateMany({
        where: { userId: ctx.userId, clearedAt: null },
        data: { clearedAt: now, clearedBy: ctx.userId, readAt: new Date() },
      })
      affected = r.count
    } else {
      return NextResponse.json({ code: 40001, msg: "参数错误（mode 非法）" })
    }
    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "NOTICE_CLEAR", resourceType: "NOTICE",
      after: { mode, affected },
      severity: "INFO",
    }).catch(() => {})
    return NextResponse.json({ code: 0, msg: `已清除 ${affected} 条通知`, data: { affected } })
  })
}

// r28：管理员发送通知（后台用户管理/公告直达；写 senderUserId 供溯源）
export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    if (ctx.role !== "SUPER_ADMIN" && ctx.role !== "ADMIN") {
      return NextResponse.json({ code: 40301, msg: "仅管理员可发送通知" })
    }
    const body = (await req.json().catch(() => ({}))) as {
      userIds?: string[]; groupIds?: string[]; title?: string; content?: string; link?: string; sourceType?: string; sourceKey?: string
    }
    if (!body.title || !body.content) return NextResponse.json({ code: 40001, msg: "标题与内容必填" })
    if (!body.userIds?.length && !body.groupIds?.length) return NextResponse.json({ code: 40001, msg: "请选择接收用户或用户组" })

    // 收集目标用户（用户直选 + 组内成员去重）
    const targetIds = new Set<string>(body.userIds || [])
    for (const gid of body.groupIds || []) {
      const members = await db.groupUser.findMany({ where: { groupId: gid }, select: { userId: true } })
      members.forEach((m) => targetIds.add(m.userId))
    }
    if (targetIds.size === 0) return NextResponse.json({ code: 40401, msg: "目标用户为空" })

    await db.notice.createMany({
      data: Array.from(targetIds).map((uid) => ({
        userId: uid,
        title: body.title!.slice(0, 120),
        content: body.content!.slice(0, 2000),
        type: "SYSTEM",
        link: body.link || null,
        sourceType: body.sourceType || null,
        sourceKey: body.sourceKey || null,
        senderUserId: ctx.userId,
      })),
    })
    return NextResponse.json({ code: 0, msg: `已发送给 ${targetIds.size} 位用户`, data: { affected: targetIds.size } })
  })
}
