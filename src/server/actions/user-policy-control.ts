"use server"

// ============================================================
// r36：用户级安全隔离 + 硬件透传 总控（后台对单个用户全部沙箱完整控制）
//
// 用户诉求：安全隔离（内网/安全位置）与远程硬件透传都要"精确到用户"，
// 并且管理员在后台改完用户级配置后，该用户的【全部沙箱】立即受控。
//
// 技术要点：策略链为 沙箱 > 用户 > 组 > 全局。用户级设置对"新建沙箱"天然生效，
// 但两类历史残留会让用户级不落地：
//   1. 沙箱级覆盖（policyAllowInternalNetwork / policyAllowSecureLocationAccess /
//      hardwareOverride 非 null）会遮蔽用户级；
//   2. 运行中沙箱的策略文件是启动时快照，须重写策略文件并重启 Chromium。
// 本模块提供：
//   · getUserPolicyControlAction：单用户策略全貌（用户级覆盖/生效值/沙箱级遮蔽数）
//   · applyUserPolicyToAllSandboxesAction：改用户级 + 清沙箱级遮蔽 + 策略文件重写 +
//     运行中 Chromium 重启（一键应用到该用户全部沙箱）
// ============================================================

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAdmin } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"

export interface UserPolicyControlData {
  userId: string
  username: string
  displayName: string | null
  userNetwork: { allowInternalNetwork: boolean | null; allowSecureLocationAccess: boolean | null }
  effectiveNetwork: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean; source: string }
  hardwarePolicy: Record<string, unknown> | null
  sandboxTotal: number
  sandboxRunning: number
  sandboxNetworkOverrides: number // 沙箱级网络覆盖遮蔽数（network 链）
  sandboxHardwareOverrides: number // 沙箱级硬件覆盖遮蔽数（hardware 链）
  sandboxes: Array<{
    id: string
    name: string
    status: string
    netOverride: { internal: boolean | null; secure: boolean | null } | null
    hardwareOverride: boolean
  }>
}

export async function getUserPolicyControlAction(input: unknown): Promise<ActionResult<UserPolicyControlData>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ userId: zId }), input)

    const user = await db.user.findUnique({
      where: { id: p.userId },
      select: { id: true, username: true, displayName: true, deletedAt: true, allowInternalNetwork: true, allowSecureLocationAccess: true, hardwarePolicy: true },
    })
    if (!user || user.deletedAt) throw bizError(ErrorCode.NOT_FOUND, "用户不存在")

    const { resolveNetworkPolicy } = await import("@/lib/network-policy")
    const eff = await resolveNetworkPolicy(user.id)

    const sandboxes = await db.browserWorkspace.findMany({
      where: { userId: user.id, deletedAt: null },
      select: {
        id: true, name: true, status: true, mode: true,
        policyAllowInternalNetwork: true, policyAllowSecureLocationAccess: true, hardwareOverride: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    })

    let netOverrides = 0
    let hwOverrides = 0
    const sbList: UserPolicyControlData["sandboxes"] = []
    for (const sb of sandboxes) {
      const internal = sb.policyAllowInternalNetwork
      const secure = sb.policyAllowSecureLocationAccess
      const netOv = internal !== null || secure !== null ? { internal, secure } : null
      if (netOv) netOverrides++
      const hwOv = !!(sb.hardwareOverride && Object.keys(sb.hardwareOverride as Record<string, unknown>).length > 0)
      if (hwOv) hwOverrides++
      sbList.push({ id: sb.id, name: sb.name, status: sb.status, netOverride: netOv, hardwareOverride: hwOv })
    }

    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      userNetwork: { allowInternalNetwork: user.allowInternalNetwork, allowSecureLocationAccess: user.allowSecureLocationAccess },
      effectiveNetwork: { allowInternalNetwork: eff.allowInternalNetwork, allowSecureLocationAccess: eff.allowSecureLocationAccess, source: eff.source },
      hardwarePolicy: (user.hardwarePolicy as Record<string, unknown> | null) || null,
      sandboxTotal: sandboxes.length,
      sandboxRunning: sandboxes.filter((s) => s.status === "RUNNING").length,
      sandboxNetworkOverrides: netOverrides,
      sandboxHardwareOverrides: hwOverrides,
      sandboxes: sbList,
    }
  })
}

const applySchema = z.object({
  userId: zId,
  scope: z.enum(["network", "hardware", "both"]),
  // 用户级网络覆盖（null=继承组/全局；scope 含 network 时必填结构）
  network: z.object({
    allowInternalNetwork: z.boolean().nullable(),
    allowSecureLocationAccess: z.boolean().nullable(),
  }).optional(),
  // 用户级硬件权限稀疏覆盖（scope 含 hardware 时可空=仅清沙箱遮蔽）
  hardwarePolicy: z.record(z.string(), z.unknown()).nullable().optional(),
  // 清除沙箱级覆盖（让用户级真正落地；默认 true）
  clearSandboxOverrides: z.boolean().default(true),
  // 重启运行中沙箱（策略文件重写后即时生效；默认 true）
  restartRunning: z.boolean().default(true),
})

export interface ApplyUserPolicyResult {
  saved: boolean
  networkSet: boolean
  hardwareSet: boolean
  clearedSandboxes: number
  policyRefreshed: number
  chromiumRestarted: number
}

export async function applyUserPolicyToAllSandboxesAction(input: unknown): Promise<ActionResult<ApplyUserPolicyResult>> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    const p = zodValidate(applySchema, input)

    const user = await db.user.findUnique({ where: { id: p.userId }, select: { id: true, username: true, displayName: true, deletedAt: true } })
    if (!user || user.deletedAt) throw bizError(ErrorCode.NOT_FOUND, "用户不存在")
    if ((p.scope === "network" || p.scope === "both") && !p.network) {
      throw bizError(ErrorCode.PARAM_ERROR, "scope 含 network 时必须提供 network 覆盖结构（null=继承上层）")
    }

    // ---- 1. 用户级覆盖写入 ----
    const userData: Record<string, unknown> = {}
    if ((p.scope === "network" || p.scope === "both") && p.network) {
      userData.allowInternalNetwork = p.network.allowInternalNetwork
      userData.allowSecureLocationAccess = p.network.allowSecureLocationAccess
    }
    if (p.scope === "hardware" || p.scope === "both") {
      if (p.hardwarePolicy === null) {
        userData.hardwarePolicy = null
      } else if (p.hardwarePolicy !== undefined) {
        // 校验走硬件策略既有清洗链（未知项/类型错误拒绝；静默授权仅超管可给）
        const { validateHardwarePolicy } = await import("@/lib/hardware-perms")
        const v = validateHardwarePolicy(p.hardwarePolicy)
        if (!v.ok) throw new Error(`硬件权限配置校验失败：${v.errors.join("；")}`)
        if (ctx.role !== "SUPER_ADMIN") {
          for (const [, st] of Object.entries(v.clean || {})) {
            if ((st as Partial<{ silent: boolean }>).silent === true) throw new Error("静默监控授权仅超级管理员可授予")
          }
        }
        userData.hardwarePolicy = v.clean ?? {}
      }
    }
    if (Object.keys(userData).length > 0) {
      await db.user.update({ where: { id: p.userId }, data: userData as never })
    }

    // ---- 2. 清除沙箱级遮蔽（该用户全部沙箱回到"跟随用户级"）----
    let cleared = 0
    if (p.clearSandboxOverrides) {
      const where = { userId: p.userId, deletedAt: null } as const
      const clearData: Record<string, unknown> = {}
      if (p.scope === "network" || p.scope === "both") {
        clearData.policyAllowInternalNetwork = null
        clearData.policyAllowSecureLocationAccess = null
      }
      if (p.scope === "hardware" || p.scope === "both") clearData.hardwareOverride = null
      if (Object.keys(clearData).length > 0) {
        const r = await db.browserWorkspace.updateMany({ where, data: clearData as never })
        cleared = r.count
      }
    }

    // ---- 3. 策略文件重写 + 运行中 Chromium 重启（即时生效）----
    let refreshed = 0
    let restarted = 0
    if (p.restartRunning) {
      const affected = await db.browserWorkspace.findMany({
        where: { userId: p.userId, deletedAt: null, mode: "novnc_full" },
        select: { id: true, containerRef: true, status: true },
        take: 100,
      })
      const { refreshWorkspacePolicyFile } = await import("@/lib/network-policy-apply")
      const { restartBrowserProcessInContainer } = await import("@/lib/external/docker")
      for (const ws of affected) {
        const ok = await refreshWorkspacePolicyFile(ws.id).catch(() => false)
        if (!ok) continue
        refreshed++
        if (ws.containerRef && ws.status === "RUNNING") {
          const r = await restartBrowserProcessInContainer(ws.containerRef).catch(() => ({ restarted: false }))
          if (r.restarted) restarted++
        }
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "USER_POLICY_APPLY_ALL",
      resourceType: "USER", resourceId: p.userId, resourceName: user.username,
      after: {
        scope: p.scope,
        network: p.network ?? null,
        hardwareSet: (p.scope === "hardware" || p.scope === "both") && p.hardwarePolicy !== undefined,
        clearSandboxOverrides: p.clearSandboxOverrides,
        clearedSandboxes: cleared,
        policyRefreshed: refreshed,
        chromiumRestarted: restarted,
      },
      severity: "WARN",
    }).catch(() => null)

    return {
      saved: true,
      networkSet: (p.scope === "network" || p.scope === "both") && !!p.network,
      hardwareSet: (p.scope === "hardware" || p.scope === "both") && p.hardwarePolicy !== undefined,
      clearedSandboxes: cleared,
      policyRefreshed: refreshed,
      chromiumRestarted: restarted,
    }
  })
}
