"use server"

// ============================================================
// r31：文件管理器用户偏好（跨端同步）
//   存 User.preferences.fileExplorer（复用既有 preferences JSON；跟随账号同步）
//   · favorites：收藏夹目录（域+路径+可自定义标题）
//   · openTabs / activeTabId：多标签页会话（跨设备恢复打开的标签 → “标签页同步”）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate } from "@/lib/validators"
import { z } from "zod"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"

export interface ExplorerFavorite {
  id: string
  domain: "ROOT_FS" | "STORAGE" | "HOME"
  path: string
  title?: string
}

export interface ExplorerTabPref {
  id: string
  domain: "ROOT_FS" | "STORAGE" | "HOME"
  path: string
}

export interface FileExplorerPrefs {
  favorites: ExplorerFavorite[]
  openTabs: ExplorerTabPref[]
  activeTabId?: string | null
}

const domainEnum = z.enum(["ROOT_FS", "STORAGE", "HOME"])

const prefsSchema = z.object({
  favorites: z.array(z.object({
    id: z.string().max(64),
    domain: domainEnum,
    path: z.string().max(1024),
    title: z.string().max(120).optional(),
  })).max(60),
  openTabs: z.array(z.object({
    id: z.string().max(64),
    domain: domainEnum,
    path: z.string().max(1024),
  })).min(1).max(12),
  activeTabId: z.string().max(64).nullable().optional(),
})

export async function getFileExplorerPrefsAction(): Promise<ActionResult<FileExplorerPrefs>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { preferences: true } })
    const prefs = (user?.preferences || {}) as { fileExplorer?: Partial<FileExplorerPrefs> }
    const fe = prefs.fileExplorer || {}
    return {
      favorites: Array.isArray(fe.favorites) ? fe.favorites : [],
      openTabs: Array.isArray(fe.openTabs) && fe.openTabs.length > 0 ? fe.openTabs : [{ id: "t1", domain: "HOME", path: "" }],
      activeTabId: typeof fe.activeTabId === "string" ? fe.activeTabId : null,
    }
  })
}

export async function saveFileExplorerPrefsAction(input: unknown): Promise<ActionResult<{ saved: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(prefsSchema, input)
    const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { preferences: true } })
    const prefs = (user?.preferences || {}) as Record<string, unknown>
    await db.user.update({
      where: { id: ctx.userId },
      data: { preferences: { ...prefs, fileExplorer: { favorites: p.favorites, openTabs: p.openTabs, activeTabId: p.activeTabId ?? null } } },
    })
    return { saved: true }
  })
}
