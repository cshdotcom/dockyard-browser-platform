// ============================================================
// r29-e：虚拟媒体投递（云盘 → 沙箱）
//   1. 音视频定点投递：云盘媒体文件复制进沙箱目录 → ffplay 投至该沙箱
//      独立 X 显示（-fs 全屏 + -ss 秒级定点 + -autoexit + -an 无声卡安全）；
//      重置 = 终止投递进程 + 清理投递文件。
//   2. 图片静态恒定帧虚拟摄像头：重写 chrome-inner.sh 注入
//      --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<img>
//      → 重启 Chromium 后 getUserMedia 恒定返回该图帧；重置 = 移除标志重启。
// 通道安全：仅服务端（管理员 RBAC）可触发；文件落沙箱专属目录（进程树隔离）。
// ============================================================

import { db } from "./db"
import { writeAudit } from "./audit"
import { readFile, writeFile, mkdir, copyFile, rm, stat } from "fs/promises"
import { join, basename, extname } from "path"
import { spawn } from "child_process"
import { ENV } from "./env"

const VIDEO_EXT = new Set([".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".ts", ".m4v"])
const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".opus"])
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"])

export function mediaKindOf(name: string): "video" | "audio" | "image" | "unknown" {
  const ext = extname(name).toLowerCase()
  if (VIDEO_EXT.has(ext)) return "video"
  if (AUDIO_EXT.has(ext)) return "audio"
  if (IMAGE_EXT.has(ext)) return "image"
  return "unknown"
}

/** 沙箱目录（storage/sandboxes/<novncSessionId>） */
function sandboxDirOf(novncSessionId: string): string {
  return join(ENV.storageLocalPath.replace(/\/$/, ""), "sandboxes", novncSessionId)
}

/** 投递目录（沙箱专属 media-in/；平台复制源文件至此） */
function mediaCastDir(novncSessionId: string): string {
  return join(sandboxDirOf(novncSessionId), "media-in")
}

// ---- 1. 音视频定点投递 ----

export interface DeliverMediaParams {
  workspaceId: string
  sourceAbsPath: string // 云盘 STORAGE 域绝对路径（file-explorer 校验后的白名单路径）
  fileName: string
  seekSec?: number
  fullscreen?: boolean
  operator: { userId: string; username: string; role: string }
}

export async function deliverMediaToSandbox(p: DeliverMediaParams): Promise<{ castId: string; pid: number | null; kind: string }> {
  const ws = await db.browserWorkspace.findFirst({
    where: { id: p.workspaceId, deletedAt: null, status: "RUNNING" },
    select: { id: true, name: true, userId: true, novncSessionId: true, mode: true },
  })
  if (!ws || ws.mode !== "novnc_full" || !ws.novncSessionId) throw new Error("沙箱不在运行状态（仅重度沙箱支持媒体投递）")

  const kind = mediaKindOf(p.fileName)
  if (kind === "unknown") throw new Error(`不支持的媒体类型：${extname(p.fileName) || "无扩展名"}（支持 视频/音频/图片）`)
  if (kind === "image") throw new Error("图片请走「虚拟摄像头」通道（恒定帧注入）")

  // 源文件校验（存在 + 大小上限 2GB）
  const st = await stat(p.sourceAbsPath).catch(() => null)
  if (!st?.isFile()) throw new Error("云盘媒体文件不存在")
  if (st.size > 2 * 1024 * 1024 * 1024) throw new Error("媒体文件超过 2GB 上限")

  // 复制进沙箱投递目录
  const { embeddedSandbox } = await import("./embedded-sandbox")
  const entry = await embeddedSandbox(ws.novncSessionId)
  if (!entry) throw new Error("沙箱进程树不可达（可能已停止）")
  const dir = mediaCastDir(ws.novncSessionId)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, basename(p.fileName))
  await copyFile(p.sourceAbsPath, dest)

  // 终止既有投递（同屏单投递语义）
  await stopMediaCastInternal(p.workspaceId, "REPLACE")

  // ffplay 投至沙箱 X 显示：
  //   视频：-fs 全屏 + -an（Xvfb 无声卡安全）
  //   音频：-showmode 1 波形可视化 + SDL_AUDIODRIVER=dummy（无声卡环境下持续可视化播放）
  const seek = Math.max(0, Math.floor(p.seekSec || 0))
  const args = [
    ...(kind === "video" ? ["-fs", "-an"] : ["-showmode", "1", "-x", "800", "-y", "450"]),
    ...(seek > 0 ? ["-ss", String(seek)] : []),
    "-autoexit", "-loglevel", "error",
    "-window_title", "DOCKYARD-MEDIACAST",
    dest,
  ]
  const proc = spawn("ffplay", args, {
    env: { ...process.env, DISPLAY: `:${entry.display}`, ...(kind === "audio" ? { SDL_AUDIODRIVER: "dummy" } : {}) },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  })
  proc.unref()

  const row = await db.mediaCast.create({
    data: {
      workspaceId: ws.id, userId: ws.userId, fileName: basename(p.fileName), mediaKind: kind,
      seekSec: seek, castPid: proc.pid, status: "PLAYING",
      deliveredByUserId: p.operator.userId, deliveredByName: p.operator.username,
      storagePath: dest,
    },
  })

  await writeAudit({
    operatorUserId: p.operator.userId, operatorName: p.operator.username,
    operationType: "MEDIA_CAST_DELIVER", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
    after: { fileName: basename(p.fileName), kind, seekSec: seek, pid: proc.pid }, severity: "WARN", ownerUserId: ws.userId,
  })
  return { castId: row.id, pid: proc.pid || null, kind }
}

async function stopMediaCastInternal(workspaceId: string, reason: string): Promise<{ stopped: number }> {
  const rows = await db.mediaCast.findMany({ where: { workspaceId, status: "PLAYING" }, select: { id: true, castPid: true, storagePath: true } })
  for (const r of rows) {
    if (r.castPid) {
      try { process.kill(r.castPid, "SIGTERM") } catch { /* 已退出 */ }
    }
    if (r.storagePath) await rm(r.storagePath, { force: true }).catch(() => null)
    await db.mediaCast.update({ where: { id: r.id }, data: { status: "STOPPED", stoppedAt: new Date(), stopReason: reason } }).catch(() => null)
  }
  return { stopped: rows.length }
}

/** 投递重置（终止当前投递 + 清理文件） */
export async function resetMediaCast(workspaceId: string, operator: { userId: string; username: string }): Promise<{ stopped: number }> {
  const r = await stopMediaCastInternal(workspaceId, "RESET")
  await writeAudit({
    operatorUserId: operator.userId, operatorName: operator.username,
    operationType: "MEDIA_CAST_RESET", resourceType: "WORKSPACE", resourceId: workspaceId,
    after: { stopped: r.stopped }, severity: "WARN",
  })
  return r
}

/** 投递状态巡检（死亡进程自动收口 STOPPED） */
export async function reapDeadMediaCasts(): Promise<{ reaped: number }> {
  const rows = await db.mediaCast.findMany({ where: { status: "PLAYING" }, select: { id: true, castPid: true } , take: 200 })
  let reaped = 0
  for (const r of rows) {
    let alive = false
    if (r.castPid) {
      alive = await new Promise<boolean>((res) => {
        try { process.kill(r.castPid!, 0); res(true) } catch { res(false) }
      })
    }
    if (!alive) {
      await db.mediaCast.update({ where: { id: r.id }, data: { status: "STOPPED", stoppedAt: new Date(), stopReason: "EXITED" } }).catch(() => null)
      reaped++
    }
  }
  return { reaped }
}

// ---- 2. 图片静态恒定帧虚拟摄像头 ----

const FAKE_CAM_FLAG = "--use-fake-device-for-media-stream"

/**
 * 注入/移除虚拟摄像头恒定帧：
 *   imagePath=null → 移除（恢复真实摄像头行为）
 *   实现：替换 chrome-inner.sh 的 __DY_FAKE_CAM__ 标记段（硬编码镜像路径，跨重启稳定）
 *         → USR1 重启 Chromium 生效；沙箱停止后重建按 hardeningJson.fakeCamImage 复原
 */
export async function setWorkspaceFakeCamera(workspaceId: string, imagePath: string | null, operator: { userId: string; username: string }): Promise<{ applied: boolean; restart: "queued" | "none" }> {
  const ws = await db.browserWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null, status: "RUNNING" },
    select: { id: true, name: true, userId: true, novncSessionId: true, mode: true, containerRef: true },
  })
  if (!ws || ws.mode !== "novnc_full" || !ws.novncSessionId) throw new Error("沙箱不在运行状态")

  if (imagePath) {
    const kind = mediaKindOf(basename(imagePath))
    if (kind !== "image") throw new Error("虚拟摄像头仅支持图片（jpg/png/webp/bmp/gif）")
  }

  const innerPath = join(sandboxDirOf(ws.novncSessionId), "chrome-inner.sh")
  const inner = await readFile(innerPath, "utf-8").catch(() => null)
  if (inner == null) throw new Error("沙箱启动脚本不可达（可能为外部容器形态）")

  // 标记段替换（幂等重写；跨重启稳定：硬编码镜像路径）
  const imgPath = imagePath ? join(mediaCastDir(ws.novncSessionId), "fake-cam" + extname(basename(imagePath))) : null
  if (imagePath && imgPath) {
    await mkdir(mediaCastDir(ws.novncSessionId), { recursive: true })
    await copyFile(imagePath, imgPath)
  }
  const imgName = imagePath ? basename(imagePath) : null
  const updated = rewriteFakeCamSection(inner, imgPath)
  await writeFile(innerPath, updated, { mode: 0o755 })

  // hardening 记录 + 审计
  const hardening = (await db.browserWorkspace.findUnique({ where: { id: ws.id }, select: { hardeningJson: true } }))?.hardeningJson as Record<string, unknown> | null
  await db.browserWorkspace.update({
    where: { id: ws.id },
    data: {
      hardeningJson: JSON.parse(JSON.stringify({ ...(hardening || {}), fakeCamImage: imgName, fakeCamAppliedAt: new Date().toISOString() })) as import("@prisma/client").Prisma.InputJsonValue,
    },
  }).catch(() => null)

  await writeAudit({
    operatorUserId: operator.userId, operatorName: operator.username,
    operationType: "MEDIA_FAKE_CAM_SET", resourceType: "WORKSPACE", resourceId: ws.id, resourceName: ws.name,
    after: { image: imgName, flags: FAKE_CAM_FLAG }, severity: "WARN", ownerUserId: ws.userId,
  })

  // 重启 Chromium 生效（USR1 = supervisor 拉起新 inner 脚本）
  let restart: "queued" | "none" = "none"
  if (ws.containerRef) {
    const { restartBrowserProcessInContainer } = await import("./external/docker")
    const r = await restartBrowserProcessInContainer(ws.containerRef).catch(() => ({ restarted: false, simulated: true }))
    if (r.restarted) restart = "queued"
  }
  return { applied: true, restart }
}

/** 沙箱投递状态查询 */
export async function workspaceMediaCastState(workspaceId: string): Promise<{
  playing: Array<{ fileName: string; kind: string; seekSec: number; by: string; startedAt: string }>
  fakeCam: { image: string | null } | null
}> {
  const [rows, ws] = await Promise.all([
    db.mediaCast.findMany({ where: { workspaceId, status: "PLAYING" }, select: { fileName: true, mediaKind: true, seekSec: true, deliveredByName: true, startedAt: true }, orderBy: { startedAt: "desc" }, take: 8 }),
    db.browserWorkspace.findUnique({ where: { id: workspaceId }, select: { hardeningJson: true } }),
  ])
  const hardening = (ws?.hardeningJson as Record<string, unknown> | null) || {}
  return {
    playing: rows.map((r) => ({ fileName: r.fileName, kind: r.mediaKind, seekSec: r.seekSec, by: r.deliveredByName || "-", startedAt: r.startedAt.toISOString() })),
    fakeCam: "fakeCamImage" in hardening ? { image: (hardening.fakeCamImage as string | null) || null } : null,
  }
}

/**
 * chrome-inner.sh 虚拟摄像头标记段重写（纯函数，冒烟直测）
 *   imgPath=null → 恢复 env 探测默认段（DY_FAKE_CAM_IMAGE）
 *   imgPath      → 硬编码恒定帧 flags 段
 */
export function rewriteFakeCamSection(inner: string, imgPath: string | null): string {
  const section = imgPath
    ? `# __DY_FAKE_CAM_BEGIN__
# r29-e: 虚拟摄像头（恒定帧注入）：图片静态恒定帧作为摄像头输出
FAKE_CAM_FLAGS="--use-fake-device-for-media-stream --use-file-for-fake-video-capture=${imgPath}"
# __DY_FAKE_CAM_END__`
    : `# __DY_FAKE_CAM_BEGIN__
# r29-e: 虚拟摄像头（恒定帧注入）—— DY_FAKE_CAM_IMAGE 指向图片时启用
FAKE_CAM_FLAGS=""
if [ -n "\${DY_FAKE_CAM_IMAGE:-}" ] && [ -f "\${DY_FAKE_CAM_IMAGE}" ]; then
  FAKE_CAM_FLAGS="--use-fake-device-for-media-stream --use-file-for-fake-video-capture=\${DY_FAKE_CAM_IMAGE}"
fi
# __DY_FAKE_CAM_END__`
  if (inner.includes("# __DY_FAKE_CAM_BEGIN__")) {
    return inner.replace(/# __DY_FAKE_CAM_BEGIN__[\s\S]*?# __DY_FAKE_CAM_END__/, section)
  }
  // 旧脚本（r29-e 之前生成）：无可识别标记 → 原样返回（不破坏）
  return inner
}
