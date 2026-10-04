// ============================================================
// r29-a：17 项硬件权限保存核心（供 Server Action / OpenAPI / 冒烟共用）
//   - 校验 + 清洗（validateHardwarePolicy）
//   - 静默授权仅 SUPER_ADMIN（服务端权威校验）
//   - 四 scope 落库（global→config / user→group→sandbox 行级覆盖）
//   - 受影响沙箱即时生效（托管策略文件重写 + 运行中重启 Chromium）
//   - 审计 HARDWARE_POLICY_SET
// ============================================================

import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { validateHardwarePolicy, type HardwarePermMap, type HardwarePermState } from "@/lib/hardware-perms"
import { getConfig, setConfig } from "@/lib/config"

export interface HardwarePolicyOperator {
  userId: string
  username: string
  role: string
}

export interface SetHardwarePolicyParams {
  scope: "global" | "user" | "group" | "sandbox"
  targetId?: string
  policy?: unknown
  clear?: boolean
}

export async function setHardwarePolicyCore(
  op: HardwarePolicyOperator,
  p: SetHardwarePolicyParams,
): Promise<{ saved: boolean; refreshed: number; restarted: number; value: HardwarePermMap | null }> {
  // global 默认档仅超管可改（影响全平台所有未显式设置的用户）
  if (p.scope === "global" && op.role !== "SUPER_ADMIN") throw new Error("全局硬件权限默认档仅超级管理员可修改")

  // 校验 + 清洗（未知项/类型错误直接拒绝）
  const validated = validateHardwarePolicy(p.clear ? null : p.policy)
  if (!validated.ok) throw new Error(`硬件权限配置校验失败：${validated.errors.join("；")}`)
  const value = p.clear ? null : validated.clean

  // 静默授权仅超管可授予（服务端二次校验——前端隐藏不构成安全边界）
  if (value && op.role !== "SUPER_ADMIN") {
    for (const [permId, v] of Object.entries(value)) {
      if ((v as Partial<HardwarePermState>).silent === true) throw new Error(`静默监控授权仅超级管理员可授予（${permId}）`)
    }
  }

  if (p.scope === "global") {
    await setConfig("hardware.defaults", value ? JSON.stringify(value) : "{}", op.userId)
  } else if (!p.targetId) {
    throw new Error("缺少目标 ID")
  } else if (p.scope === "user") {
    await db.user.update({ where: { id: p.targetId }, data: { hardwarePolicy: value as never } })
  } else if (p.scope === "group") {
    await db.group.update({ where: { id: p.targetId }, data: { hardwarePolicy: value as never } })
  } else {
    await db.browserWorkspace.update({ where: { id: p.targetId }, data: { hardwareOverride: value as never } })
  }

  // ---- 受影响沙箱即时生效（托管策略文件重写 + 运行中重启 Chromium）----
  let affected: Array<{ id: string; containerRef: string | null; status: string }> = []
  if (p.scope === "sandbox" && p.targetId) {
    const ws = await db.browserWorkspace.findFirst({ where: { id: p.targetId, deletedAt: null }, select: { id: true, containerRef: true, status: true } })
    if (ws) affected = [ws]
  } else if (p.scope === "user" && p.targetId) {
    affected = await db.browserWorkspace.findMany({ where: { userId: p.targetId, deletedAt: null, mode: "novnc_full" }, select: { id: true, containerRef: true, status: true }, take: 50 })
  } else if (p.scope === "group" && p.targetId) {
    const members = await db.groupUser.findMany({ where: { groupId: p.targetId }, select: { userId: true } })
    affected = await db.browserWorkspace.findMany({ where: { userId: { in: members.map((m) => m.userId) }, deletedAt: null, mode: "novnc_full" }, select: { id: true, containerRef: true, status: true }, take: 50 })
  } else if (p.scope === "global") {
    affected = await db.browserWorkspace.findMany({ where: { deletedAt: null, mode: "novnc_full" }, select: { id: true, containerRef: true, status: true }, take: 100 })
  }

  let refreshed = 0
  let restarted = 0
  const { refreshWorkspacePolicyFile } = await import("./network-policy-apply")
  for (const ws of affected) {
    const ok = await refreshWorkspacePolicyFile(ws.id).catch(() => false)
    if (!ok) continue
    refreshed++
    if (ws.containerRef && ws.status === "RUNNING") {
      const { restartBrowserProcessInContainer } = await import("./external/docker")
      const r = await restartBrowserProcessInContainer(ws.containerRef).catch(() => ({ restarted: false, simulated: true }))
      if (r.restarted) restarted++
    }
  }

  await writeAudit({
    operatorUserId: op.userId, operatorName: op.username,
    operationType: "HARDWARE_POLICY_SET",
    resourceType: p.scope === "global" ? "SYSTEM_CONFIG" : p.scope === "user" ? "USER" : p.scope === "group" ? "GROUP" : "WORKSPACE",
    resourceId: p.targetId || "hardware.defaults",
    after: { scope: p.scope, value, refreshed, restarted, by: op.username },
    severity: "WARN",
  })
  return { saved: true, refreshed, restarted, value }
}

/** 读取全局默认档（解析层） */
export async function getGlobalHardwareDefaults(): Promise<HardwarePermMap | null> {
  const defaultsStr = await getConfig("hardware.defaults", "{}")
  try { return JSON.parse(String(defaultsStr || "{}")) as HardwarePermMap } catch { return null }
}
