import { db } from "@/lib/db"
import { GuestViewPanel } from "./guest-view"
import { getConfigBool, getConfigNumber } from "@/lib/config"
import { resolveGuestShareControl } from "@/lib/share-policy"

// ============================================================
// r37：访客访问页（免登录分享链接）
// 形态：/view/<token>（32 字节随机 hex —— 不可猜测；本页不经登录守卫）
//   · 链接校验：存在/未撤销/未过期/次数 → 访客开放 → 沙箱否决 → 发起人访客链
//   · 密码门控（设置了 passwordHash → 客户端输密码后经公共 API 校验）
//   · VNC 模式 → 嵌入 HelmPortViewer（VIEW=只读 / OPERATE=可操作；服务端强制）
//   · CDP 模式 / 访客 CDP → 取票面板（外网地址 + 复制 + 时效提示）
//   · 登录用户访问 → 引导走 /workspaces/shared（兑换绑定，权限更完整）
// ============================================================

export const dynamic = "force-dynamic"
export const metadata = { title: "访客接入 · Dockyard", robots: { index: false, follow: false } }

export default async function GuestViewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const cleanToken = (token || "").trim()

  const link = cleanToken && /^[a-f0-9]{16,128}$/i.test(cleanToken)
    ? await db.workspaceShareLink.findUnique({ where: { token: cleanToken } })
    : null

  // 基础校验（不暴露任何敏感信息）
  if (!link) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "分享链接不存在（可能已失效或被撤销）" }} />
  }
  const now = Date.now()
  if (link.revokedAt) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "该分享链接已被撤销" }} />
  }
  if (link.expireAt && link.expireAt.getTime() < now) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "该分享链接已过期" }} />
  }
  if (link.maxUses > 0 && link.useCount >= link.maxUses) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "该分享链接使用次数已达上限" }} />
  }
  if (!link.guestAllowed) {
    // 未开放访客 → 引导登录兑换（与 r22b 登录门控语义一致）
    return (
      <GuestViewPanel
        state={{
          kind: "login-required",
          msg: "该链接仅向已登录用户开放（兑换后将获得工作区共享授权）",
          redeemUrl: `/workspaces/shared?token=${cleanToken}`,
        }}
      />
    )
  }

  const ws = await db.browserWorkspace.findFirst({ where: { id: link.workspaceId, deletedAt: null } })
  if (!ws || ws.deletedAt) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "链接指向的工作区已不存在" }} />
  }
  if (ws.shareDisabled) {
    return <GuestViewPanel state={{ kind: "invalid", msg: "该工作区已被管理员禁止共享，链接已失效" }} />
  }
  if (ws.status === "FROZEN") {
    return <GuestViewPanel state={{ kind: "invalid", msg: `工作区已离线冻结封存${ws.freezeReason ? `（${ws.freezeReason}）` : ""}` }} />
  }

  // 发起人访客链（链接创建后收紧 → 立即拒接；管理员豁免语义由 role 控制）
  const creatorId = link.createdByUserId || ws.userId
  const ctl = creatorId ? await resolveGuestShareControl({ userId: creatorId, workspaceId: ws.id, role: "USER" }) : null
  if (ctl && !ctl.allowed) {
    return <GuestViewPanel state={{ kind: "invalid", msg: `访客访问已被管理员限制：${ctl.reason}` }} />
  }

  const globalViewOnly = await getConfigBool("session.vncGlobalViewOnly", false)
  const guestMaxMin = await getConfigNumber("share.guestMaxSessionMinutes", 120)

  return (
    <GuestViewPanel
      state={{
        kind: "guest",
        token: cleanToken,
        hasPassword: !!link.passwordHash,
        workspace: {
          id: ws.id, uuid: ws.uuid, name: ws.name, status: ws.status,
          mode: ws.mode, novncSessionId: ws.novncSessionId,
          crashCategory: ws.crashCategory ?? null, freezeReason: ws.freezeReason ?? null,
          ownerName: "", mySharePermission: link.permission, isOwner: false, isAdmin: false,
        },
        permission: link.permission,
        guestCdp: link.guestCdp && link.permission === "OPERATE",
        readonly: link.permission !== "OPERATE" || globalViewOnly,
        guestMaxSessionMinutes: guestMaxMin,
      }}
    />
  )
}
