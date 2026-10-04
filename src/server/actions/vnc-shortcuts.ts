"use server"

// r28：VNC 快捷键用户偏好（同步跨端）
// 存 User.preferences.vncShortcuts（复用既有 preferences JSON；跟随账号同步）

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate } from "@/lib/validators"
import { z } from "zod"
import { requireAuth } from "@/lib/permissions"
import { db } from "@/lib/db"

export interface CustomShortcut {
  id: string
  label: string
  title: string
  keys: number[] // keysym 序列（down 顺序；up 由执行器逆序）
}

export async function getMyShortcutsAction(): Promise<ActionResult<{ shortcuts: CustomShortcut[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { preferences: true } })
    const prefs = (user?.preferences || {}) as { vncShortcuts?: CustomShortcut[] }
    return { shortcuts: Array.isArray(prefs.vncShortcuts) ? prefs.vncShortcuts : [] }
  })
}

const saveSchema = z.object({
  shortcuts: z.array(z.object({
    id: z.string().max(64),
    label: z.string().max(64),
    title: z.string().max(200),
    keys: z.array(z.number().int().min(0).max(0xffffff)).min(1).max(8),
  })).max(60),
})

export async function saveMyShortcutsAction(input: unknown): Promise<ActionResult<{ saved: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(saveSchema, input)
    const user = await db.user.findUnique({ where: { id: ctx.userId }, select: { preferences: true } })
    const prefs = (user?.preferences || {}) as Record<string, unknown>
    await db.user.update({
      where: { id: ctx.userId },
      data: { preferences: { ...prefs, vncShortcuts: p.shortcuts } },
    })
    return { saved: p.shortcuts.length }
  })
}
