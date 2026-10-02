import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// 站内通知：GET 列表+未读数；PATCH 单条标记已读（站内信小弹窗「标记已读」）；PUT 全部已读
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    const items = await db.notice.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 30,
    })
    const unread = items.filter((i) => !i.readAt).length
    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        items: items.map((i) => ({ id: i.id, title: i.title, content: i.content, type: i.type, link: i.link || null, readAt: i.readAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() })),
        unread,
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
    await db.notice.updateMany({ where: { userId: ctx.userId, readAt: null }, data: { readAt: new Date() } })
    return NextResponse.json({ code: 0, msg: "全部已读" })
  })
}
