"use server"

// ============================================================
// r29-e：虚拟媒体投递 Server Actions
//   · deliverMediaAction —— 云盘音视频定点秒级投递（ffplay 至沙箱 X 显示）
//   · resetMediaCastAction —— 投递重置（终止 + 清理）
//   · setFakeCameraAction —— 图片静态恒定帧虚拟摄像头（注入/移除）
//   · listCloudMediaAction —— 云盘 STORAGE 域媒体文件清单（投递选择器）
//   · getMediaCastStateAction —— 沙箱投递状态
// 路径安全：resolveDomainPath 白名单解析（穿越拒绝）+ STORAGE 域敏感目录拒读
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate, zId } from "@/lib/validators"
import { z } from "zod"
import { requireAdmin, requireWritableMode } from "@/lib/permissions"
import { db } from "@/lib/db"
import { readdir, stat } from "fs/promises"
import { join } from "path"
import { ENV } from "@/lib/env"
import { resolveDomainPath, extOf, kindOf } from "@/lib/file-explorer"

// ---- 云盘媒体清单（STORAGE 域浅层枚举 + 一层子目录） ----
export async function listCloudMediaAction(input: unknown): Promise<ActionResult<{ files: Array<{ name: string; path: string; kind: string; sizeMb: number }> }>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ rel: z.string().max(256).optional() }), input)
    const roots = { ROOT_FS: "/", STORAGE: ENV.storageLocalPath.replace(/\/$/, ""), HOME: "" }
    const rel = p.rel || ""
    const { abs, ok } = resolveDomainPath(roots, "STORAGE", rel)
    if (!ok) throw new Error("非法路径")
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
    const files: Array<{ name: string; path: string; kind: string; sizeMb: number }> = []
    for (const e of entries) {
      if (e.isDirectory()) continue
      const k = kindOf(e.name)
      if (k !== "video" && k !== "audio" && k !== "image") continue
      const st = await stat(join(abs, e.name)).catch(() => null)
      files.push({ name: e.name, path: rel ? `${rel}/${e.name}` : e.name, kind: k, sizeMb: st ? Math.round((st.size / 1048576) * 10) / 10 : 0 })
    }
    files.sort((a, b) => b.sizeMb - a.sizeMb)
    return { files: files.slice(0, 200) }
  })
}

// ---- 音视频定点投递 ----
export async function deliverMediaAction(input: unknown): Promise<ActionResult<{ castId: string; kind: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, relPath: z.string().min(1).max(512), seekSec: z.number().int().min(0).max(86399).optional() }), input)

    // 白名单解析（穿越拒绝）
    const roots = { ROOT_FS: "/", STORAGE: ENV.storageLocalPath.replace(/\/$/, ""), HOME: "" }
    const { abs, ok } = resolveDomainPath(roots, "STORAGE", p.relPath)
    if (!ok) throw new Error("非法路径（目录穿越拒绝）")

    const { deliverMediaToSandbox } = await import("@/lib/media-cast")
    const r = await deliverMediaToSandbox({
      workspaceId: p.workspaceId, sourceAbsPath: abs, fileName: p.relPath.split("/").pop() || "media",
      seekSec: p.seekSec, operator: { userId: ctx.userId, username: ctx.username, role: ctx.role },
    })
    return { castId: r.castId, kind: r.kind }
  })
}

// ---- 投递重置 ----
export async function resetMediaCastAction(input: unknown): Promise<ActionResult<{ stopped: number }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    const { resetMediaCast } = await import("@/lib/media-cast")
    return await resetMediaCast(p.workspaceId, { userId: ctx.userId, username: ctx.username })
  })
}

// ---- 虚拟摄像头恒定帧 ----
export async function setFakeCameraAction(input: unknown): Promise<ActionResult<{ applied: boolean; restart: string }>> {
  return actionHandler(async () => {
    await requireWritableMode()
    const ctx = await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId, relPath: z.string().max(512).optional().nullable() }), input)

    let abs: string | null = null
    if (p.relPath) {
      const roots = { ROOT_FS: "/", STORAGE: ENV.storageLocalPath.replace(/\/$/, ""), HOME: "" }
      const resolved = resolveDomainPath(roots, "STORAGE", p.relPath)
      if (!resolved.ok) throw new Error("非法路径（目录穿越拒绝）")
      if (kindOf(p.relPath.split("/").pop() || "") !== "image") throw new Error("仅支持图片文件")
      abs = resolved.abs
    }

    const { setWorkspaceFakeCamera } = await import("@/lib/media-cast")
    return await setWorkspaceFakeCamera(p.workspaceId, abs, { userId: ctx.userId, username: ctx.username })
  })
}

// ---- 沙箱投递状态 ----
export async function getMediaCastStateAction(input: unknown): Promise<ActionResult<{
  playing: Array<{ fileName: string; kind: string; seekSec: number; by: string; startedAt: string }>
  fakeCam: { image: string | null } | null
}>> {
  return actionHandler(async () => {
    await requireAdmin()
    const p = zodValidate(z.object({ workspaceId: zId }), input)
    const { workspaceMediaCastState } = await import("@/lib/media-cast")
    return await workspaceMediaCastState(p.workspaceId)
  })
}
