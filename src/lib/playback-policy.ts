/**
 * r28：回放安全策略（水印 / 导出）四级链
 * 优先级：沙箱覆盖（BrowserWorkspace.vncPlayback）> 用户（User.vncPlayback）
 *        > 用户组（Group.vncPlayback，含父组继承）> 全局配置键
 *
 * watermark: "force" 强制水印（用户不可关闭，前端无法移除标记）
 *            "on"     默认开启（用户可临时关闭本次）
 *            "off"    默认关闭
 * allowExport: 是否允许下载/导出（false=仅可在线回放，下载路由 403）
 *
 * 水印时间戳以服务器时间（北京时间 UTC+8）为准，前端不可篡改（服务端下发 ISO+偏移标签）。
 */

import { db } from "@/lib/db"

export interface PlaybackPolicy {
  watermark: "force" | "on" | "off"
  allowExport: boolean
  source: "SANDBOX" | "USER" | "GROUP" | "GLOBAL"
  /** 服务器当前时间（北京时间语义；下发 ISO 串由前端格式化显示） */
  serverNow: string
  serverTz: string
}

type Sparse = { watermark?: "force" | "on" | "off"; allowExport?: boolean } | null

const GLOBAL_DEFAULT: Required<Pick<PlaybackPolicy, "watermark" | "allowExport">> = {
  watermark: "on", // 用户要求：回放水印默认开启
  allowExport: false, // 默认不允许导出（仅在线回放；后台可放开）
}

function mergeSparse(base: { watermark: "force" | "on" | "off"; allowExport: boolean }, sparse: Sparse, source: PlaybackPolicy["source"]): { merged: typeof base; source: PlaybackPolicy["source"] } {
  if (!sparse) return { merged: base, source: "GLOBAL" }
  const merged = { ...base }
  let hit = false
  if (sparse.watermark) { merged.watermark = sparse.watermark; hit = true }
  if (typeof sparse.allowExport === "boolean") { merged.allowExport = sparse.allowExport; hit = true }
  return { merged, source: hit ? source : "GLOBAL" }
}

/** 解析：workspaceId 存在时走四级；否则用户>组>全局 */
export async function resolvePlaybackPolicy(userId: string, workspaceId?: string): Promise<PlaybackPolicy> {
  const { getConfig } = await import("@/lib/config")
  const gWm = await getConfig("vnc.playbackWatermark", GLOBAL_DEFAULT.watermark)
  const gExp = (await getConfig("vnc.playbackAllowExport", GLOBAL_DEFAULT.allowExport ? "true" : "false")) === "true"
  const wm = (["force", "on", "off"].includes(String(gWm)) ? String(gWm) : "on") as "force" | "on" | "off"
  let merged = { watermark: wm, allowExport: gExp }
  let source: PlaybackPolicy["source"] = "GLOBAL"

  // 用户组（含继承链向上，首个命中组级）
  const user = await db.user.findUnique({ where: { id: userId }, select: { vncPlayback: true, username: true } })
  const groupLinks = await db.groupUser.findMany({ where: { userId }, select: { groupId: true } })
  for (const gl of groupLinks) {
    let gid: string | null = gl.groupId
    let depth = 0
    while (gid && depth < 6) {
      const group = await db.group.findUnique({ where: { id: gid }, select: { vncPlayback: true, parentId: true } })
      if (!group) break
      if (group.vncPlayback) {
        const r = mergeSparse(merged, group.vncPlayback as Sparse, "GROUP")
        if (r.source !== "GLOBAL") { merged = r.merged; source = "GROUP" }
        break
      }
      gid = group.parentId
      depth++
    }
  }

  // 用户级
  if (user?.vncPlayback) {
    const r = mergeSparse(merged, user.vncPlayback as Sparse, "USER")
    merged = r.merged
    if (r.source !== "GLOBAL") source = "USER"
  }

  // 沙箱级覆盖（最强）
  if (workspaceId) {
    const ws = await db.browserWorkspace.findUnique({ where: { id: workspaceId }, select: { vncPlayback: true } })
    if (ws?.vncPlayback) {
      const r = mergeSparse(merged, ws.vncPlayback as Sparse, "SANDBOX")
      merged = r.merged
      if (r.source !== "GLOBAL") source = "SANDBOX"
    }
  }

  return {
    watermark: merged.watermark,
    allowExport: merged.allowExport,
    source,
    serverNow: beijingNow(),
    serverTz: "UTC+8 (北京时间)",
  }
}

/** 北京时间字符串（服务器权威；不依赖客户端时钟） */
export function beijingNow(): string {
  const now = new Date()
  return beijingFormat(now)
}

export function beijingFormat(d: Date): string {
  const beijing = new Date(d.getTime() + 8 * 3600_000)
  return `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, "0")}-${String(beijing.getUTCDate()).padStart(2, "0")} ${String(beijing.getUTCHours()).padStart(2, "0")}:${String(beijing.getUTCMinutes()).padStart(2, "0")}:${String(beijing.getUTCSeconds()).padStart(2, "0")} CST`
}

/** 校验稀疏 JSON（保存路径用） */
export function validatePlaybackOverride(v: unknown): Sparse {
  if (v == null) return null
  if (typeof v !== "object") throw new Error("策略格式错误")
  const o = v as Record<string, unknown>
  const out: { watermark?: "force" | "on" | "off"; allowExport?: boolean } = {}
  if ("watermark" in o) {
    if (!["force", "on", "off"].includes(String(o.watermark))) throw new Error("watermark 取值：force | on | off")
    out.watermark = o.watermark as "force" | "on" | "off"
  }
  if ("allowExport" in o) {
    if (typeof o.allowExport !== "boolean") throw new Error("allowExport 必须为布尔")
    out.allowExport = o.allowExport
  }
  if (Object.keys(out).length === 0) return null
  return out
}
