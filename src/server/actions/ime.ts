"use server"

// r24-c：沙箱输入法（IME）Server Actions
// - getWorkspaceImeAction：查询沙箱输入法状态（可用输入法清单/当前引擎/当前布局/偏好持久值）
// - setWorkspaceImeAction：切换输入法或键盘布局（作用域=该沙箱 X 显示；持久化偏好；审计）
//
// 权限：工作区所有者 / OPERATE 共享接收者 / 管理员（与 VNC 剪贴板通道同口径）
// 隔离语义：每沙箱独立 Xvfb + 独立 fcitx5 —— 切换只影响该沙箱，其他沙箱与在线用户互不影响

import { z } from "zod"
import { db } from "@/lib/db"
import { actionHandler, type ActionResult } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { zodValidate, zId } from "@/lib/validators"
import { bizError, ErrorCode } from "@/lib/errors"
import {
  listImeEngines,
  listKbLayouts,
  fcitx5Installed,
  setxkbmapInstalled,
  imeCurrentEngine,
  imeCurrentKbLayout,
  applyImeEngine,
  applyKbLayout,
  type ImeRuntimeHandle,
} from "@/lib/ime-control"
import { embeddedSandbox, embeddedSandboxAlive } from "@/lib/embedded-sandbox"

export interface ImeEngineView {
  name: string
  label: string
  category: string
}

export interface WorkspaceImeStatus {
  supported: boolean
  reason: string | null
  fcitx5Installed: boolean
  setxkbmapInstalled: boolean
  engines: ImeEngineView[]
  layouts: { name: string; label: string }[]
  current: { engine: string | null; kbLayout: string | null }
  preferred: { engine: string | null; kbLayout: string | null }
}

// 归属校验：所有者 / OPERATE 共享 / 管理员
async function assertImeAccess(wsId: string, userId: string, username: string, isAdmin: boolean) {
  const ws = await db.browserWorkspace.findFirst({ where: { id: wsId, deletedAt: null } })
  if (!ws) throw bizError(ErrorCode.NOT_FOUND, "工作区不存在")
  if (ws.userId !== userId && !isAdmin) {
    const share = await db.workspaceShare.findFirst({
      where: { workspaceId: ws.id, targetUserId: userId, permission: "OPERATE", revokedAt: null, OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
    })
    if (!share) throw bizError(ErrorCode.FORBIDDEN, "无权操作该工作区输入法（需所有者/操作共享/管理员）")
  }
  return ws
}

// 解析运行时句柄：仅内嵌形态（containerRef=emb-* 且监督树存活）支持实时切换
async function resolveRuntime(ws: { containerRef: string | null; novncSessionId: string | null }): Promise<ImeRuntimeHandle | null> {
  const ref = ws.containerRef || ws.novncSessionId
  if (!ref || !ref.startsWith("emb-")) return null
  const entry = await embeddedSandbox(ref)
  if (!entry || !embeddedSandboxAlive(entry)) return null
  return { display: entry.display, linuxUser: entry.linuxUser, sandboxDir: entry.sandboxDir }
}

// ---- 1. 查询沙箱输入法状态 ----
export async function getWorkspaceImeAction(input: unknown): Promise<ActionResult<WorkspaceImeStatus>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    const ws = await assertImeAccess(p.workspaceId, ctx.userId, ctx.username, ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN")

    const runtime = await resolveRuntime(ws)
    const fcitx = fcitx5Installed()
    const xkb = setxkbmapInstalled()
    const engines = listImeEngines()
    const layouts = await listKbLayouts()

    let reason: string | null = null
    if (!runtime) reason = ws.status !== "RUNNING" && ws.status !== "IDLE" ? `工作区当前状态 ${ws.status}（仅运行中可切换）` : "当前部署形态不支持实时输入法切换（仅单容器内嵌沙箱支持）"
    else if (!fcitx) reason = "容器未安装 fcitx5 输入法组件（镜像需含 fcitx5 全家桶；键盘布局切换仍可用）"

    return {
      supported: !!runtime,
      reason,
      fcitx5Installed: fcitx,
      setxkbmapInstalled: xkb,
      engines,
      layouts,
      current: runtime ? { engine: fcitx ? imeCurrentEngine(runtime) : null, kbLayout: imeCurrentKbLayout(runtime) } : { engine: null, kbLayout: null },
      preferred: { engine: ws.imeEngine, kbLayout: ws.kbLayout },
    }
  })
}

// ---- 2. 切换输入法 / 键盘布局 ----
const setSchema = z.object({
  workspaceId: zId,
  engine: z.string().regex(/^[\w.-]{1,64}$/).optional(),
  kbLayout: z.string().regex(/^[a-z]{2,8}$/).optional(),
  persist: z.boolean().optional().default(true), // false=仅当前会话生效（不落库）
})

export async function setWorkspaceImeAction(input: unknown): Promise<ActionResult<{ appliedEngine: string | null; appliedKbLayout: string | null; persisted: boolean; current: { engine: string | null; kbLayout: string | null } }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    const p = zodValidate(setSchema, input)
    if (!p.engine && !p.kbLayout) throw bizError(ErrorCode.PARAM_ERROR, "至少指定 engine 或 kbLayout 之一")
    const ws = await assertImeAccess(p.workspaceId, ctx.userId, ctx.username, isAdmin)
    const runtime = await resolveRuntime(ws)
    if (!runtime) throw bizError(ErrorCode.RESOURCE_IN_USE, "沙箱未在运行（仅运行中的内嵌沙箱支持实时切换）")

    let appliedEngine: string | null = null
    let appliedKbLayout: string | null = null

    if (p.engine) {
      const engines = listImeEngines()
      if (!engines.some((e) => e.name === p.engine)) throw bizError(ErrorCode.PARAM_ERROR, `未知输入法：${p.engine}`)
      const r = applyImeEngine(runtime, p.engine)
      if (!r.ok) throw bizError(ErrorCode.EXTERNAL_SERVICE, r.error || "输入法切换失败")
      appliedEngine = p.engine
    }
    if (p.kbLayout) {
      const layouts = await listKbLayouts()
      if (!layouts.some((l) => l.name === p.kbLayout)) throw bizError(ErrorCode.PARAM_ERROR, `未知键盘布局：${p.kbLayout}`)
      const r = applyKbLayout(runtime, p.kbLayout)
      if (!r.ok) throw bizError(ErrorCode.EXTERNAL_SERVICE, r.error || "键盘布局切换失败")
      appliedKbLayout = p.kbLayout
    }

    // 偏好持久化（下次沙箱启动自动应用）
    const persisted = p.persist
    if (persisted) {
      await db.browserWorkspace.update({
        where: { id: ws.id },
        data: {
          ...(appliedEngine !== null ? { imeEngine: appliedEngine } : {}),
          ...(appliedKbLayout !== null ? { kbLayout: appliedKbLayout } : {}),
        },
      })
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "IME_CHANGE",
      resourceType: "WORKSPACE",
      resourceId: ws.id,
      resourceName: ws.name,
      ownerUserId: ws.userId,
      after: { engine: appliedEngine, kbLayout: appliedKbLayout, persisted, display: `:${runtime.display}` },
      severity: "INFO",
    })

    return {
      appliedEngine,
      appliedKbLayout,
      persisted,
      current: { engine: fcitx5Installed() ? imeCurrentEngine(runtime) : null, kbLayout: imeCurrentKbLayout(runtime) },
    }
  })
}
