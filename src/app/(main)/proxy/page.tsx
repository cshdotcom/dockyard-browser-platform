import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { getConfig } from "@/lib/config"
import { ProxyPage as ProxyPageView } from "./proxy-page"
import { Anchor, Gauge, Globe2, ShieldCheck } from "lucide-react"

// ============================================================
// r35：用户侧代理 / 加速器总览（修复"代理/加速器实例 404"）
// 展示：我的工作区代理绑定 / 平台代理通道状态（sing-box 实例健康度只读视图）
// ============================================================
export default async function Page() {
  const ctx = await getAuthContext()
  if (!ctx) redirect("/login")

  // 我的工作区代理绑定
  const myWorkspaces = await db.browserWorkspace.findMany({
    where: { userId: ctx.userId, deletedAt: null },
    select: {
      id: true, name: true, status: true, mode: true,
      proxyNodeId: true, singboxInstanceId: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
  const proxyNodeIds = [...new Set(myWorkspaces.map((w) => w.proxyNodeId).filter((v): v is string => !!v))]
  const singboxIds = [...new Set(myWorkspaces.map((w) => w.singboxInstanceId).filter((v): v is string => !!v))]

  const proxyNodes = await db.proxyNode.findMany({
    where: proxyNodeIds.length > 0 ? { id: { in: proxyNodeIds } } : { id: { in: ["__none__"] } },
    select: { id: true, name: true, type: true, status: true },
  })
  const singboxes = await db.singboxInstance.findMany({
    where: singboxIds.length > 0 ? { id: { in: singboxIds }, deletedAt: null } : { id: { in: ["__none__"] } },
    select: { id: true, name: true, status: true, socksAddr: true, remark: true },
  })
  const mode = await getConfig<string>("singbox.routeMode", "rule")

  const nodeMap = new Map(proxyNodes.map((n) => [n.id, n]))
  const sbMap = new Map(singboxes.map((s) => [s.id, s]))
  const unbound = myWorkspaces.filter((w) => !w.proxyNodeId && !w.singboxInstanceId).length

  const stats = [
    { label: "代理绑定工作区", value: myWorkspaces.length - unbound, icon: <Anchor className="h-4 w-4" /> },
    { label: "直连工作区", value: unbound, icon: <Globe2 className="h-4 w-4" /> },
    { label: "代理通道", value: proxyNodes.length + singboxes.length, icon: <Gauge className="h-4 w-4" /> },
    { label: "全局路由模式", value: mode === "rule" ? "规则模式" : mode === "proxy" ? "全局代理" : "全局直连", icon: <ShieldCheck className="h-4 w-4" /> },
  ]

  return (
    <ProxyPageView
      stats={stats.map((s) => ({ label: s.label, value: String(s.value), icon: s.icon }))}
      rows={myWorkspaces.map((w) => {
        const pn = w.proxyNodeId ? nodeMap.get(w.proxyNodeId) : null
        const sb = w.singboxInstanceId ? sbMap.get(w.singboxInstanceId) : null
        return {
          id: w.id,
          name: w.name,
          wsStatus: w.status,
          mode: w.mode,
          proxyName: pn?.name ?? sb?.name ?? null,
          proxyType: pn?.type ?? (sb ? "internal_singbox" : null),
          proxyStatus: pn?.status ?? sb?.status ?? null,
          socksAddr: sb?.socksAddr ?? null,
        }
      })}
    />
  )
}
