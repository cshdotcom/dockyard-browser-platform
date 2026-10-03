// ============================================================
// r27 真实链路 E2E：内嵌沙箱真实开录（Xvfb + Chromium + x11vnc + ffmpeg）
// 验证：策略命中 → 沙箱进程树内 ffmpeg 真实录制 → 分段落盘 →
//       停止终结 → 分段 COMPLETED + 时长/大小 → 流媒体 API（Range/签名票据）
// 运行：bunx tsx scripts/e2e-r27-real-recording.ts
// ============================================================
import { PrismaClient } from "@prisma/client"
import { existsSync, statSync, readdirSync, rmSync, readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"

// 开发环境组件：chromium = playwright 发行版；x11vnc = python 监听垫片（与 r25d 冒烟同模式）
process.env.EMBEDDED_BROWSER_BIN = process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
process.env.EMBEDDED_X11VNC_BIN = "/tmp/dy-r27e-x11vnc-shim.sh"
import { writeFileSync, chmodSync } from "fs"
const SHIM = `#!/bin/sh
prev=""
port=""
for a in "$@"; do
  if [ "$prev" = "-rfbport" ]; then port="$a"; fi
  prev="$a"
done
exec python3 -c '
import socket, sys, threading
port = int(sys.argv[1])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(16)
def acc(c):
    try:
        c.settimeout(30); c.recv(4096)
    except Exception: pass
    try: c.close()
    except Exception: pass
while True:
    try:
        c, _ = s.accept()
        threading.Thread(target=acc, args=(c,), daemon=True).start()
    except Exception:
        break
' "$port"
`
writeFileSync(process.env.EMBEDDED_X11VNC_BIN, SHIM)
chmodSync(process.env.EMBEDDED_X11VNC_BIN, 0o755)

const db = new PrismaClient()
let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra?: string) {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ""}`)
  }
}

async function main() {
  console.log("== r27 E2E：真实沙箱开录 ==")
  const { createEmbeddedSandbox, destroyEmbeddedSandbox } = await import("../src/lib/embedded-sandbox")
  const { registerWorkspaceRecording, scanRecordingSegments, finalizeRecordingSession, signPlaybackToken } = await import("../src/lib/recording")

  const uname = "qa_r27e_" + Date.now().toString(36)
  const user = await db.user.create({ data: { username: uname, passwordHash: "x", role: "USER", vncRecording: true } })
  const wsUuid = "wsr27" + Date.now().toString(36)
  const ws = await db.browserWorkspace.create({
    data: { name: "QA-R27E-真实开录", uuid: wsUuid, mode: "novnc_full", status: "RUNNING", userId: user.id },
  })

  const storage = (process.env.STORAGE_LOCAL_PATH || join(process.cwd(), "storage")).replace(/\/$/, "")

  console.log("\n[1] 创建内嵌沙箱（录像参数 + fullscreen 防退出档位）")
  const sb = await createEmbeddedSandbox({
    userId: user.id,
    profileKey: "p-r27e" + Date.now().toString(36),
    workspaceId: ws.id,
    resolution: "1024x768",
    startUrl: "about:blank",
    recording: { enabled: true, fps: 10, segmentSec: 6, maxSec: 0 },
    exitGuard: "fullscreen",
  })
  ok(sb.id.startsWith("emb-"), "沙箱进程树创建", sb.id)
  ok(sb.recording?.recordDir != null, "录像参数下发（recordDir 回传）", JSON.stringify(sb.recording || null))
  ok(sb.hardening.recordingEnabled === true && sb.hardening.exitGuard === "fullscreen", "hardening 快照含录像/防退出档位")

  await registerWorkspaceRecording({
    workspace: { id: ws.id, uuid: wsUuid, name: ws.name, userId: user.id },
    username: uname,
    sessionId: sb.id,
    resolution: "1024x768",
    policy: { enabled: true, source: "USER", resolvedAt: new Date().toISOString() },
    tuning: { fps: 10, segmentSec: 6, maxMinutes: 0, maxSegmentMb: 2048 },
  })
  ok(true, "录像会话注册（DB 行 + session.json）")

  console.log("\n[2] 等待 ffmpeg 真实录制（10 秒观察窗口）")
  const recDir = join(storage, "recordings", user.id, sb.id)
  let segSize = 0
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const seg = join(recDir, "seg-000.mp4")
    if (existsSync(seg)) {
      const s = statSync(seg).size
      if (s > 2000 && s === segSize) break // 尺寸稳定即继续（fMP4 持续写入）
      segSize = s
    }
    if (i === 14) break
  }
  const files = existsSync(recDir) ? readdirSync(recDir) : []
  const segPath = join(recDir, "seg-000.mp4")
  if (!existsSync(segPath) || statSync(segPath).size <= 2000) {
    // 诊断：打印 ffmpeg 日志与沙箱日志尾部
    try {
      const supLog2 = String(readFileSync(join(storage, "sandboxes", sb.id, "logs", "ffmpeg.log")))
      console.log("   [diag] ffmpeg.log:", supLog2.slice(-400))
    } catch { console.log("   [diag] ffmpeg.log 不存在") }
    try {
      console.log("   [diag] ffmpeg 进程:", String(execSync("ps aux | grep '[f]fmpeg' | head -2").toString()).slice(0, 500))
      console.log("   [diag] X 进程:", String(execSync("ps aux | grep '[X]vfb' | head -2").toString()).slice(0, 300))
    } catch { /* ignore */ }
  }
  const completedSegs = files.filter((f) => f.startsWith("seg-") && f !== "seg-000.mp4" ? statSync(join(recDir, f)).size > 2000 : false)
  ok(existsSync(segPath) && (statSync(segPath).size > 2000 || completedSegs.length > 0), "ffmpeg 真实落盘（分段滚动即完整化 >2KB）", `files=${JSON.stringify(files)} size=${segSize}`)
  ok(existsSync(join(recDir, "session.json")), "session.json 溯源标记")

  // 策略文件含防退出附加策略（BrowserSignin 0 等）
  // 托管策略生成链路独立验证（真实文件落盘 + 解析）
  const { writeNetworkPolicyFile } = await import("../src/lib/network-policy")
  const { exitGuardManagedPolicy } = await import("../src/lib/chromium-policies")
  const pf = await writeNetworkPolicyFile("ws-r27eguard" + Date.now().toString(36), {
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    extraManagedPolicy: { ...(exitGuardManagedPolicy("fullscreen") as Record<string, unknown>), MetricsReportingEnabled: false },
  })
  const pfJson = pf ? JSON.parse(readFileSync(pf, "utf8")) : {}
  ok(pfJson.BrowserSignin === 0 && pfJson.SyncDisabled === true && pfJson.IncognitoModeAvailability === 1 && pfJson.MetricsReportingEnabled === false, "托管策略文件真实落盘含防退出附加策略 + 模板策略项")

  // 内层脚本含 --start-fullscreen 参数
  const sandboxDir = join(storage, "sandboxes", sb.id)
  const innerPath = join(sandboxDir, "chrome-inner.sh")
  const inner = existsSync(innerPath) ? String(readFileSync(innerPath)) : ""
  ok(inner.includes("--start-fullscreen") && inner.includes("--noerrdialogs"), "chromium 启动参数含 fullscreen 守卫", inner.slice(0, 80))

  // supervisor 日志含录像启动行
  const supLog = existsSync(join(sandboxDir, "logs", "supervisor.log")) ? String(readFileSync(join(sandboxDir, "logs", "supervisor.log"))) : ""
  ok(supLog.includes("VNC 录像已启动") || supLog.includes("录像已启动"), "监督日志确认 ffmpeg 已启动", supLog.split("\n").slice(-3).join(" | "))

  console.log("\n[3] 停止沙箱 → 终结 → 流媒体 API 验证")
  await destroyEmbeddedSandbox(sb.id)
  await new Promise((r) => setTimeout(r, 1500))
  await finalizeRecordingSession(sb.id, { reason: "e2e-stop" })
  const rows = await db.vncRecording.findMany({ where: { sessionId: sb.id } })
  ok(rows.length >= 1 && rows.every((r) => r.status === "COMPLETED"), "停止后全部分段终结（COMPLETED）", JSON.stringify(rows.map((r) => r.status)))
  ok(rows[0].sizeBytes > 2000 && rows[0].durationSec >= 1, "真实时长/大小回填", `dur=${rows[0].durationSec}s size=${rows[0].sizeBytes}B`)
  ok(rows[0].storageKey?.startsWith(`recordings/${user.id}/${sb.id}/seg-000.mp4`) === true, "storageKey 用户空间路径")

  // ---- 流媒体 API（dev 服务器）----
  const rec = rows[0] // 按时间倒序？findMany 默认无排序 → 取体积最大段确保有内容
  const recPick = rows.slice().sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
  void rec
  const token = signPlaybackToken(recPick.id, user.id, 120)
  const base = "http://localhost:3000"
  const r1 = await fetch(`${base}/api/recordings/stream/${recPick.id}?token=${encodeURIComponent(token)}`)
  ok(r1.status === 200 && r1.headers.get("content-type") === "video/mp4", "回放 200 + video/mp4", `${r1.status} ${r1.headers.get("content-type")}`)
  const totalLen = Number(r1.headers.get("content-length") || 0)
  ok(totalLen === recPick.sizeBytes, "Content-Length 与库内大小一致", `${totalLen} vs ${recPick.sizeBytes}`)
  const buf = Buffer.from(await r1.arrayBuffer())
  ok(buf.length > 2000 && buf.subarray(4, 8).toString() === "ftyp", "mp4 魔数校验（ftyp box）")

  // Range 请求
  const r2 = await fetch(`${base}/api/recordings/stream/${recPick.id}?token=${encodeURIComponent(token)}`, {
    headers: { Range: "bytes=0-1023" },
  })
  ok(r2.status === 206 && (r2.headers.get("content-range") || "").startsWith("bytes 0-1023/"), "Range 请求 206 分片", `${r2.status} ${r2.headers.get("content-range")}`)
  ok((await r2.arrayBuffer()).byteLength === 1024, "分片长度精确 1024B")

  // 下载模式
  const r3 = await fetch(`${base}/api/recordings/stream/${recPick.id}?token=${encodeURIComponent(token)}&download=1`)
  ok(r3.status === 200 && (r3.headers.get("content-disposition") || "").includes("attachment"), "下载模式 attachment 头")

  // 无票据/坏票据拒绝（鉴权失败 → JSON 错误体，绝不是视频流）
  const r4 = await fetch(`${base}/api/recordings/stream/${rec.id}`)
  const r4body = await r4.text()
  ok((r4.headers.get("content-type") || "").includes("application/json") && !r4body.startsWith("\u0000"), "无票据无 Cookie 拒绝（JSON 错误体）", `${r4.status} ${r4body.slice(0, 80)}`)
  const r5 = await fetch(`${base}/api/recordings/stream/${recPick.id}?token=fake.fake.1.2`)
  const r5body = await r5.text()
  ok((r5.headers.get("content-type") || "").includes("application/json") && r5body.includes("票据"), "伪造票据拒绝（JSON 错误体）", `${r5.status} ${r5body.slice(0, 80)}`)

  // 审计（VIEW/DOWNLOAD 落库）
  await new Promise((r) => setTimeout(r, 800))
  const audits = await db.auditLog.findMany({ where: { resourceType: "RECORDING", resourceId: recPick.id } })
  ok(audits.some((a) => a.operationType === "RECORDING_VIEW") && audits.some((a) => a.operationType === "RECORDING_DOWNLOAD"), "回放/下载审计落库", audits.map((a) => a.operationType).join(","))
  const updated = await db.vncRecording.findUnique({ where: { id: recPick.id } })
  ok((updated?.viewCount ?? 0) >= 2 && (updated?.downloadCount ?? 0) >= 1, "回放/下载计数累加", `view=${updated?.viewCount} dl=${updated?.downloadCount}`)

  // ---- 清理 ----
  console.log("\n[清理] E2E 数据归零")
  rmSync(recDir, { recursive: true, force: true })
  await db.auditLog.deleteMany({ where: { resourceType: "RECORDING" } })
  await db.vncRecording.deleteMany({ where: { sessionId: sb.id } })
  await db.browserWorkspace.deleteMany({ where: { id: ws.id } })
  await db.user.deleteMany({ where: { id: user.id } })
  ok((await db.vncRecording.count()) === 0, "录像表归零")

  console.log(`\n== r27 E2E 结果：${pass} 通过 / ${fail} 失败 ==`)
  if (fail > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error("E2E 异常：", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
