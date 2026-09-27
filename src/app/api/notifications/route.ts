import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// 站内通知：GET 列表+未读数；PUT 全部已读
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
        items: items.map((i) => ({ id: i.id, title: i.title, content: i.content, type: i.type, readAt: i.readAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() })),
        unread,
      },
    })
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
