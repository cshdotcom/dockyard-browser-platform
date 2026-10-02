// 临时分享链接兑换页（服务端登录门控 + 客户端兑换面板）
// r22b 登录门控：外链兑换强制要求已登录 —— 未登录访问 token 链接时，
// 服务端校验会话（深度校验：LoginSession 撤销/过期/闲置同样视为未登录），
// redirect 到 /login?from=原链接（含 token，登录成功后自动回来完成绑定）。
// 注：全局 middleware（src/proxy.ts）对 /workspaces/** 有第一层 JWT 守卫，
// 本页为兑换语义的第二层强制门控（防御纵深）。

import { redirect } from "next/navigation"
import { getAuthContext } from "@/lib/permissions"
import { SharedRedeemPanel } from "./redeem-panel"

export const dynamic = "force-dynamic"

export default async function SharedWorkspaceRedeemPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const sp = await searchParams
  const token = (sp.token || "").trim()

  // 兑换前置：必须已登录（收到链接的用户打开带有效期的链接时须为已登录状态方可加入）
  const ctx = await getAuthContext()
  if (!ctx) {
    const returnTo = token ? `/workspaces/shared?token=${token}` : "/workspaces/shared"
    redirect(`/login?from=${encodeURIComponent(returnTo)}`)
  }

  return <SharedRedeemPanel token={token} />
}
