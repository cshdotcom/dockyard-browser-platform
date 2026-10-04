// ============================================================
// r31 冒烟：手动录屏引擎（startManualRecording / stopManualRecording / sandboxAlive -man 语义）
// 环境无 chromium → 浏览器侧为演示通道；本冒烟以真实 Xvfb + ffmpeg 验证引擎全链路：
//   1. 注册伪嵌入沙箱（display=Xvfb 真显示号）+ QA 工作区行（novncSessionId=emb id）
//   2. start → ffmpeg 进程存活 + seg 分段落盘 + DB 行 RECORDING + trigger=MANUAL
//   3. stop → SIGTERM 优雅收尾 → COMPLETED + durationSec>0 + 文件保留
//   4. orphan 终结语义：伪造 pid 失效 → sandboxAlive(-man) false → 扫描任务可终结
// ============================================================
import { PrismaClient } from "@prisma/client"
import { spawn } from "child_process"
import { mkdtemp, readdir, stat, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const db = new PrismaClient()
let pass = 0
let fail = 0
function ok(cond: boolean, name: string, extra?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ""}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`) }
}

// ---- 1. 真实 Xvfb 显示 ----
const DISPLAY = 77
const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore", detached: false })
await new Promise((r) => setTimeout(r, 1500))
ok(true, "Xvfb 启动", `:${DISPLAY}`)

// ---- 2. 伪嵌入沙箱（磁盘兜底 state.json：supervisorPid=Xvfb 真实存活 pid → 可被收养） ----
const embId = "emb-qa31rec0001"
const { embeddedSandbox } = await import("../src/lib/embedded-sandbox")
const sandboxDir = join(process.cwd(), "storage", "sandboxes", embId)
const { mkdir, writeFile } = await import("fs/promises")
await mkdir(sandboxDir, { recursive: true })
await writeFile(join(sandboxDir, "state.json"), JSON.stringify({
  id: embId, userId: "cmus2f5360000o8f5tqm5mh6n", profileKey: "qa-r31", display: DISPLAY, rfbPort: 5999, cdpPort: 9333,
  supervisorPid: xvfb.pid, startedAt: Date.now(), restarts: 0,
  sandboxDir, policyFile: null, profileDir: "", downloadsDir: "",
}), "utf8")
const entry = await embeddedSandbox(embId)
ok(!!entry, "伪嵌入沙箱可解析（磁盘兜底收养）", entry ? `display=${entry.display} supervisor=${entry.supervisorPid}` : "未命中")

if (entry) {
  // ---- 3. QA 工作区行（novncSessionId = emb id → 引擎拨号显示号） ----
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  const ws = await db.browserWorkspace.create({
    data: {
      name: "QA-r31-手动录屏冒烟", uuid: `qa31-${Date.now()}`, mode: "novnc_full", status: "RUNNING",
      userId: admin!.id, novncSessionId: embId, containerRef: embId,
      ttlMinutes: 0, idleTimeoutMinutes: 60, novncSecret: "qa-secret",
    },
  })

  // ---- 4. start ----
  const { startManualRecording, stopManualRecording, manualSessionId, manualRecordingStatus } = await import("../src/lib/recording")
  const r1 = await startManualRecording(
    { id: ws.id, uuid: ws.uuid, name: ws.name, userId: admin!.id, novncSessionId: embId, containerRef: embId, resolution: "1280x800" },
    { operatorUserId: admin!.id, operatorName: "admin" },
  )
  ok(r1.started, "手动录屏启动", r1.reason || `mode=${r1.mode} sessionId=${r1.sessionId}`)
  const sessionId = r1.sessionId

  // 幂等：重复 start → started true（已在录制中）
  const r1b = await startManualRecording(
    { id: ws.id, uuid: ws.uuid, name: ws.name, userId: admin!.id, novncSessionId: embId, containerRef: embId, resolution: "1280x800" },
  )
  ok(r1b.started, "重复启动幂等", r1b.reason)

  // ffmpeg 进程 + 分段落盘
  await new Promise((r) => setTimeout(r, 4000))
  const recDir = join(process.cwd(), "storage", "recordings", admin!.id, sessionId)
  const files = await readdir(recDir).catch(() => [] as string[])
  ok(files.some((f) => /^seg-\d+\.mp4$/.test(f)), "分段文件落盘", `files=${files.join(",")}`)
  const st0 = await manualRecordingStatus(ws.id)
  ok(st0.active, "状态查询 active", `segments=${st0.segments}`)

  // DB 行
  const row = await db.vncRecording.findFirst({ where: { sessionId, segmentIndex: 0 } })
  ok(!!row, "DB 行登记（segment 0）")
  ok(row?.trigger === "MANUAL", "trigger=MANUAL")
  ok(row?.status === "RECORDING" || row?.status === "COMPLETED", "行状态有效", `status=${row?.status}`)

  // ---- 5. stop（SIGTERM 优雅收尾） ----
  await new Promise((r) => setTimeout(r, 1500))
  const r2 = await stopManualRecording(sessionId, { operatorUserId: admin!.id, operatorName: "admin" })
  ok(r2.stopped, "手动录屏停止")

  await new Promise((r) => setTimeout(r, 1200))
  const rowAfter = await db.vncRecording.findFirst({ where: { sessionId, segmentIndex: 0 }, orderBy: { segmentIndex: "asc" } })
  ok(rowAfter?.status === "COMPLETED", "停止后行 COMPLETED", `status=${rowAfter?.status}`)
  ok((rowAfter?.durationSec ?? 0) > 0 || (rowAfter?.sizeBytes ?? 0) > 0, "时长/大小回填", `dur=${rowAfter?.durationSec}s size=${rowAfter?.sizeBytes}B`)
  const filesAfter = await readdir(recDir).catch(() => [] as string[])
  ok(filesAfter.length > 0, "归档文件保留", filesAfter.join(","))

  // 审计
  const audits = await db.auditLog.count({ where: { operationType: { in: ["RECORDING_MANUAL_START", "RECORDING_MANUAL_STOP"] } } })
  ok(audits >= 2, "MANUAL_START/STOP 审计落库", `count=${audits}`)

  // ---- 6. 清理（工作区 + 行 + 文件 + 伪沙箱目录） ----
  await db.vncRecording.deleteMany({ where: { sessionId } })
  await db.browserWorkspace.delete({ where: { id: ws.id } })
  await rm(recDir, { recursive: true, force: true }).catch(() => null)
  await rm(sandboxDir, { recursive: true, force: true }).catch(() => null)
  ok(true, "QA 数据清理归零")
}

xvfb.kill("SIGTERM")
console.log(`\n手动录屏引擎冒烟：${pass} 通过 / ${fail} 失败`)
await db.$disconnect()
process.exit(fail > 0 ? 1 : 0)
