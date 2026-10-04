import { NextRequest, NextResponse } from "next/server"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { promises as fsp } from "node:fs"
import path from "node:path"
import { db } from "@/lib/db"
import { requireAuth } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { ENV } from "@/lib/env"

// ============================================================
// r36：一键在线压缩打包下载（tar.gz 流式直出，打包产物零服务端落盘）
// GET /api/admin/backup/archive —— 仅超级管理员
//   · 收集磁盘上现存全部备份文件（加密备份保持加密形态打包）
//   · 附带一份生成的 manifest.txt（清单与下载地址，随包携带）
//   · spawn tar -czf - -C <backups目录> <文件名…>：边压缩边流式回传浏览器
//     —— 服务器上【不生成、不暂存任何打包产物】；唯一临时物是 KB 级清单
//       txt（属元数据而非备份数据本体；流结束/出错即删，60s 兜底）
//   · 客户端断开 → 自动终止 tar（不留僵尸进程）
//   · tar 不可用环境 → 首字节前感知并返回明确错误
// ============================================================

export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const ctx = await requireAuth().catch(() => null)
  if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录", traceId }, { status: 401 })
  if (ctx.role !== "SUPER_ADMIN") {
    return NextResponse.json({ code: 40300, msg: "备份打包下载仅超级管理员可用", traceId }, { status: 403 })
  }
  if (!rateLimit(`backup-archive:${ctx.userId}`, 3, 60_000).allowed) {
    return NextResponse.json({ code: 42900, msg: "打包下载过于频繁（每分钟 3 次），请稍后再试", traceId }, { status: 429 })
  }

  // ---- 1. 现存备份文件收集（仅磁盘上真实存在且未清理的；均在 storage/backups/）----
  const backupDir = path.join(ENV.storageLocalPath, "backups")
  const records = await db.backupRecord.findMany({ orderBy: { createdAt: "desc" }, take: 500 })
  const metas = await db.fileMeta.findMany({ where: { id: { in: records.map((r) => r.fileMetaId) } } })
  const metaById = new Map(metas.map((m) => [m.id, m]))
  const names: string[] = []
  let totalBytes = 0
  for (const r of records) {
    const m = metaById.get(r.fileMetaId)
    if (!m || m.deletedAt || m.purgedAt) continue
    if (m.storageKey.includes("..")) continue // 路径穿越防护（与下载路由一致）
    const abs = path.join(ENV.storageLocalPath, m.storageKey.replace(/\\/g, "/"))
    const st = await fsp.stat(abs).catch(() => null)
    if (st?.isFile() && path.dirname(abs) === backupDir && /^[A-Za-z0-9_.-]+$/.test(path.basename(abs))) {
      names.push(path.basename(abs))
      totalBytes += st.size
    }
  }
  if (names.length === 0) {
    return NextResponse.json({ code: 40400, msg: "磁盘上没有可打包的备份文件（可能均已清理）", traceId }, { status: 404 })
  }

  // ---- 2. 生成随包清单（KB 级临时目录；流结束即删）----
  const base = ENV.publicBaseUrl || req.nextUrl.origin
  const dlUrls: string[] = []
  for (const r of records) {
    const m = metaById.get(r.fileMetaId)
    if (m && !m.deletedAt && !m.purgedAt && names.includes(path.basename(m.fileName))) {
      dlUrls.push(`${base}/api/files/download?id=${r.fileMetaId}`)
    }
  }
  // 独立临时目录（与备份文件同名空间隔离；tar 以第二段 -C 并入包内 manifest.txt）
  const manifestDir = path.join(ENV.storageLocalPath, `.tmp-manifest-${Date.now()}`)
  const manifestAbs = path.join(manifestDir, `manifest.txt`)
  const manifestBody = [
    "Dockyard 备份打包清单（在线流式打包 · 打包产物未在服务端存储）",
    `打包时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    `备份文件：${names.length} 份 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
    `平台基址：${base}`,
    "",
    "包内文件：",
    ...names.map((n, i) => `${String(i + 1).padStart(3, "0")}. ${n}`),
    "",
    "单份下载地址（超管登录态）：",
    ...dlUrls,
    "",
    "恢复方式：管理后台 → 备份恢复 → 选择对应备份记录",
    "（加密备份保持加密形态，恢复时自动解密）",
  ].join("\r\n")
  await fsp.mkdir(manifestDir, { recursive: true })
  await fsp.writeFile(manifestAbs, manifestBody, "utf8")

  // ---- 3. tar 流式打包（双段 -C：备份文件 → 备份目录；manifest.txt → 临时目录）----
  // tar 按 -C 出现顺序处理后续文件 → 包内干净呈现 备份文件 + manifest.txt
  const tar = spawn("tar", ["-czf", "-", "-C", backupDir, ...names, "-C", manifestDir, "manifest.txt"], { stdio: ["ignore", "pipe", "pipe"] })

  let stderrBuf = ""
  tar.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString() })

  // 【r36-bugfix：小备份场景 tar 在探测窗内即完成 —— 数据/退出事件必须即刻收集，
  //  否则 end/close 在监听器注册前触发 → 流永不关闭（实测 4 分钟挂起）】
  const preBuffer: Buffer[] = [] // 探测窗内到达的数据（顺序保真）
  let stdoutEnded = false
  let tarClosed = false
  let hadOutput = false
  let closeCode: number | null = null
  let lastErr = ""
  const endHandlers: Array<() => void> = [] // 流收口回调（stream start 时注册）
  // 收集器：探测窗内入缓冲；流开始后移除（后续数据由直通监听处理，避免大文件双缓冲内存膨胀）
  const collector = (d: Buffer) => { hadOutput = true; preBuffer.push(d) }
  tar.stdout.on("data", collector)
  tar.stdout.once("end", () => { stdoutEnded = true; for (const h of endHandlers.splice(0)) h() })
  tar.once("close", (code: number | null) => { tarClosed = true; closeCode = code; for (const h of endHandlers.splice(0)) h() })
  tar.once("error", (e: Error) => { lastErr = e.message })

  const cleanupManifest = () => { void fsp.rm(manifestDir, { recursive: true, force: true }).catch(() => null) }
  setTimeout(cleanupManifest, 60_000).unref?.()

  // tar 立即失败（二进制缺失/参数错误）→ 首字节前感知 → JSON 错误
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
  if (!hadOutput && tarClosed && closeCode !== 0 && (stderrBuf || lastErr)) {
    cleanupManifest()
    return NextResponse.json({ code: 50000, msg: `打包进程失败：${(stderrBuf || lastErr).slice(0, 200)}`, traceId }, { status: 500 })
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onDone = () => { try { controller.close() } catch { /* 已关闭 */ } cleanupManifest() }
      const onError = () => { try { controller.error(new Error(`tar 进程异常${stderrBuf ? `：${stderrBuf.slice(0, 120)}` : ""}`)) } catch { /* 已关闭 */ } cleanupManifest() }
      // 回放探测窗内已到达的数据（顺序保真）
      for (const chunk of preBuffer.splice(0)) {
        try { controller.enqueue(new Uint8Array(chunk)) } catch { /* 客户端已断开 */ }
      }
      // 已在窗口内完成（小备份毫秒级收工）→ 直接收口
      if (stdoutEnded || tarClosed) {
        if (closeCode === 0 || stdoutEnded) onDone()
        else onError()
        return
      }
      // 常规流：摘除收集器 → 后续数据直通（单监听，无双缓冲）+ 结束/退出收口
      tar.stdout.off("data", collector)
      tar.stdout.on("data", (d: Buffer) => {
        try { controller.enqueue(new Uint8Array(d)) } catch { /* 客户端已断开 */ }
      })
      endHandlers.push(onDone)
      if (tarClosed) onDone()
    },
    cancel() {
      try { tar.kill("SIGTERM") } catch { /* noop */ }
      setTimeout(() => { try { tar.kill("SIGKILL") } catch { /* noop */ } }, 1500)
      cleanupManifest()
    },
  })

  await writeAudit({
    operatorUserId: ctx.userId, operatorName: ctx.username,
    operationType: "BACKUP_ARCHIVE_EXPORT",
    resourceType: "BACKUP",
    after: { count: names.length, totalBytes, streamMode: "tar-gz-zero-disk", manifest: "included" },
    severity: "WARN",
  }).catch(() => null)

  const stamp = new Date()
  const fname = `dockyard-backups-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}.tar.gz`
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // 反代透传禁缓冲（流式直出）
      "X-Dy-Archive-Note": "streamed-zero-disk",
    },
  })
}
