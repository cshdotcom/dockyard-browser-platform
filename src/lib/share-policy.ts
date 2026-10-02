import { db } from "@/lib/db"
import { bizError, ErrorCode } from "@/lib/errors"
import { getConfig, getConfigBool } from "@/lib/config"
import { userGroupIds } from "@/lib/permissions"

// ============================================================
// r13c：工作区共享四级管控（企业级共享权限体系）
// 解析优先级（deny 优先，越靠近资源越优先）：
//   1. 沙箱级 shareDisabled（管理员总列表否决开关，最高优先级）
//   2. 用户级 shareAllowed（三态：null=继承组，true/false 强制覆盖）
//   3. 用户组级 allowShare（用户归属多组时任一组禁止即禁止，与权限锁语义一致）
//   4. 全局 share.globalAllow（SystemConfig，默认 true）
//   5. 兼容既有 blockShareWorkspace 权限锁链（用户锁/组锁/全局锁）——历史机制保持生效
// 管理端（SUPER_ADMIN/ADMIN）不受限：共享管控约束的是普通用户的分享行为
// ============================================================

export interface ShareControlResult {
  allowed: boolean
  /** 生效层级（allowed=false 时即阻断层级） */
  source: "sandbox" | "user" | "group" | "global" | "legacy-lock" | "default"
  /** 阻断原因（allowed=false 时非空，前端按钮禁用提示用） */
  reason: string
}

interface ShareControlOpts {
  userId: string
  /** 工作区 id（提供时叠加沙箱级否决检查） */
  workspaceId?: string
  /** 跳过管理员豁免（兑换链接等场景按共享发起人解析时传 false 由调用方控制语义） */
  role?: string
}

export async function resolveShareControl(opts: ShareControlOpts): Promise<ShareControlResult> {
  const { userId, workspaceId } = opts
  const role = opts.role

  // 管理员豁免（共享管控针对普通用户/组管理员的分享行为；管理员侧由审计追溯）
  if (role === "SUPER_ADMIN" || role === "ADMIN") {
    return { allowed: true, source: "default", reason: "" }
  }

  // ---- 1. 沙箱级否决（最高优先级） ----
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({
      where: { id: workspaceId },
      select: { shareDisabled: true, name: true },
    })
    if (ws?.shareDisabled) {
      return { allowed: false, source: "sandbox", reason: "该工作区已被管理员禁止共享（沙箱级否决）" }
    }
  }

  // ---- 2/3. 用户级三态 → 组级开关 ----
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { shareAllowed: true, permissionLocks: true },
  })
  if (user?.shareAllowed === false) {
    return { allowed: false, source: "user", reason: "管理员已禁止你共享工作区（用户级开关）" }
  }
  if (user?.shareAllowed === true) {
    // 用户级显式允许：不再看组开关（覆盖语义），继续检查沙箱/全局/遗留锁
  } else {
    // null=继承组：任一归属组禁止即禁止
    const gids = await userGroupIds(userId)
    if (gids.length) {
      const groups = await db.group.findMany({
        where: { id: { in: gids } },
        select: { allowShare: true, name: true },
      })
      const deniedGroup = groups.find((g) => g.allowShare === false)
      if (deniedGroup) {
        return { allowed: false, source: "group", reason: `所属用户组「${deniedGroup.name}」已被管理员禁止共享` }
      }
    }
  }

  // ---- 4. 全局开关 ----
  const globalAllow = await getConfigBool("share.globalAllow", true)
  if (!globalAllow) {
    return { allowed: false, source: "global", reason: "管理员已全局关闭工作区共享功能" }
  }

  // ---- 5. 遗留权限锁链兼容（blockShareWorkspace：用户锁 → 组锁 → 全局锁） ----
  const locks = (user?.permissionLocks as Record<string, boolean>) || {}
  if (locks.blockShareWorkspace === true) {
    return { allowed: false, source: "legacy-lock", reason: "管理员已禁止分享工作区（权限锁）" }
  }
  if (await groupLockCheck(userId, "blockShareWorkspace")) {
    return { allowed: false, source: "legacy-lock", reason: "所属用户组权限锁已禁止分享工作区" }
  }
  const globalLocks = await getConfig<Record<string, boolean>>("permission.globalLocks", {})
  if (globalLocks.blockShareWorkspace === true) {
    return { allowed: false, source: "legacy-lock", reason: "全局权限锁已禁止分享工作区" }
  }

  return { allowed: true, source: "default", reason: "" }
}

async function groupLockCheck(userId: string, lockKey: string): Promise<boolean> {
  const gids = await userGroupIds(userId)
  for (const gid of gids) {
    const g = await db.group.findUnique({ where: { id: gid }, select: { policy: true } })
    const policy = (g?.policy as Record<string, unknown>) || {}
    const locks = (policy.permissionLocks as Record<string, boolean>) || {}
    if (locks[lockKey] === true) return true
  }
  return false
}

/** 共享动作统一门禁：不通过直接抛业务异常（403 语义） */
export async function assertShareAllowed(opts: ShareControlOpts & { role: string }): Promise<ShareControlResult> {
  const r = await resolveShareControl(opts)
  if (!r.allowed) {
    throw bizError(ErrorCode.PERMISSION_LOCKED, r.reason || "共享功能已被管理员禁用")
  }
  return r
}
