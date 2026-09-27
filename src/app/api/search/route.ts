import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { apiHandler } from "@/lib/api"

// 全局搜索：模糊搜索 工作区/SingBox实例/用户/代理节点 —— 结果按资源类型分组，权限过滤
export async function GET(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await getAuthContext()
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" })
    const q = (req.nextUrl.searchParams.get("q") || "").trim()
    if (q.length < 2) return NextResponse.json({ code: 0, msg: "ok", data: { groups: [] } })
    const isAdmin = ctx.role === "SUPER_ADMIN" || ctx.role === "ADMIN"
    const kw = { contains: q }

    const [workspaces, singboxes, users, proxies] = await Promise.all([
      db.browserWorkspace.findMany({
        where: isAdmin ? { OR: [{ name: kw }, { uuid: kw }], deletedAt: null } : { userId: ctx.userId, OR: [{ name: kw }, { uuid: kw }], deletedAt: null },
        take: 5,
        select: { id: true, name: true, uuid: true, status: true },
      }),
      isAdmin
        ? db.singboxInstance.findMany({ where: { OR: [{ name: kw }, { remark: kw }], deletedAt: null }, take: 5, select: { id: true, name: true, status: true } })
        : Promise.resolve([]),
      isAdmin
        ? db.user.findMany({ where: { OR: [{ username: kw }, { email: kw }, { displayName: kw }], deletedAt: null }, take: 5, select: { id: true, username: true, displayName: true } })
        : Promise.resolve([]),
      isAdmin
        ? db.proxyNode.findMany({ where: { OR: [{ name: kw }], deletedAt: null }, take: 5, select: { id: true, name: true, status: true } })
        : Promise.resolve([]),
    ])

    const groups = [
      {
        group: "浏览器工作区",
        items: workspaces.map((w) => ({ id: w.id, label: `${w.name} · ${w.uuid.slice(0, 12)} · ${w.status}`, href: `/workspaces/${w.id}` })),
      },
      {
        group: "SingBox 实例",
        items: singboxes.map((s) => ({ id: s.id, label: `${s.name} · ${s.status}`, href: `/admin/singbox?focus=${s.id}` })),
      },
      {
        group: "用户",
        items: users.map((u) => ({ id: u.id, label: `${u.username}${u.displayName ? ` · ${u.displayName}` : ""}`, href: `/admin/users?focus=${u.id}` })),
      },
      {
        group: "代理节点",
        items: proxies.map((p) => ({ id: p.id, label: `${p.name} · ${p.status}`, href: `/admin/network?focus=${p.id}` })),
      },
    ].filter((g) => g.items.length > 0)

    return NextResponse.json({ code: 0, msg: "ok", data: { groups } })
  })
}
