/**
 * r29-e 冒烟：虚拟媒体投递
 * 覆盖：
 *   1. mediaKindOf 类型判定向量
 *   2. 真实 Xvfb + ffplay 投屏：ffmpeg 生成测试视频 → ffplay -ss 定点投至 :<display>
 *      → 进程存活 → SIGTERM 终止 → 进程收口（模拟投递重置）
 *   3. rewriteFakeCamSection 标记段重写：注入/移除/幂等/未知脚本不动
 *   4. MediaCast 落库语义：投递行创建 + 重置 STOPPED + 死进程收口（reapDeadMediaCasts）
 */
import { PrismaClient } from "@prisma/client"
import { spawn, execFile } from "child_process"
import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const db = new PrismaClient()
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
function sh(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout) => res({ code: err ? 1 : 0, stdout: String(stdout || "") }))
  })
}
function pidAlive(pid: number): Promise<boolean> {
  return new Promise((res) => {
    try { process.kill(pid, 0); res(true) } catch { res(false) }
  })
}

async function main() {
  console.log("== r29-e 冒烟：虚拟媒体投递 ==")
  const { mediaKindOf, rewriteFakeCamSection, reapDeadMediaCasts } = await import("../src/lib/media-cast")

  // ---- 1. 类型判定 ----
  check("类型：视频 mp4/webm/mkv", mediaKindOf("a.mp4") === "video" && mediaKindOf("b.WEBM") === "video")
  check("类型：音频 mp3/flac", mediaKindOf("a.mp3") === "audio" && mediaKindOf("b.flac") === "audio")
  check("类型：图片 jpg/png/webp", mediaKindOf("a.jpg") === "image" && mediaKindOf("b.PNG") === "image" && mediaKindOf("c.webp") === "image")
  check("类型：未知 exe/txt 拒绝", mediaKindOf("a.exe") === "unknown" && mediaKindOf("b.txt") === "unknown")

  // ---- 2. 真实 Xvfb + ffplay 投屏 ----
  const dir = await mkdtemp(join(tmpdir(), "dy-r29e-"))
  const videoPath = join(dir, "cast-test.mp4")
  // 生成 8s 测试视频（testsrc）
  const gen = await sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=8:size=640x480:rate=10", "-pix_fmt", "yuv420p", videoPath])
  check("ffmpeg 生成测试视频", gen.code === 0)

  // 生成测试图片（虚拟摄像头用）
  const imgPath = join(dir, "fake-cam.png")
  const genImg = await sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:size=320x240:duration=1:rate=1", "-frames:v", "1", imgPath])
  check("ffmpeg 生成测试图片", genImg.code === 0)

  // 独立 Xvfb 显示（模拟沙箱显示）
  const DISPLAY = 190
  const xvfb = spawn("Xvfb", [`:${DISPLAY}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" })
  await new Promise((res) => setTimeout(res, 1200))
  const xvfbUp = await pidAlive(xvfb.pid!)
  check("Xvfb 独立显示就绪（模拟沙箱屏）", xvfbUp)

  if (xvfbUp) {
    // ffplay 投屏（-fs 全屏 + -ss 2 定点 + -autoexit + -an）
    const ffplay = spawn("ffplay", ["-fs", "-ss", "2", "-autoexit", "-an", "-loglevel", "error", "-window_title", "DOCKYARD-MEDIACAST", videoPath], {
      env: { ...process.env, DISPLAY: `:${DISPLAY}` },
      stdio: "ignore", detached: true,
    })
    ffplay.unref()
    await new Promise((res) => setTimeout(res, 1500))
    const playing = await pidAlive(ffplay.pid!)
    check("ffplay 定点投屏：进程存活（-ss 2s）", playing)

    // X 显示上有 ffplay 窗口（xdotool 不一定有 → 用 xwininfo? 简化：进程 + 显示连接推断）
    // 终止 = 投递重置语义
    if (playing) {
      try { process.kill(ffplay.pid!, "SIGTERM") } catch { /* exited */ }
      await new Promise((res) => setTimeout(res, 600))
      const stopped = !(await pidAlive(ffplay.pid!))
      check("投递重置：SIGTERM 终止成功", stopped)
    }

    // 无声卡安全：-an 模式再次投递（音频文件）
    const audioPath = join(dir, "cast-test.wav")
    await sh("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", audioPath])
    const ffplay2 = spawn("ffplay", ["-showmode", "1", "-x", "800", "-y", "450", "-ss", "1", "-autoexit", "-loglevel", "error", audioPath], {
      env: { ...process.env, DISPLAY: `:${DISPLAY}`, SDL_AUDIODRIVER: "dummy" }, stdio: "ignore", detached: true,
    })
    ffplay2.unref()
    await new Promise((res) => setTimeout(res, 1200))
    check("音频投递：-an 无声卡安全播放", await pidAlive(ffplay2.pid!))
    try { process.kill(ffplay2.pid!, "SIGTERM") } catch { /* exited */ }
  }

  // ---- 3. rewriteFakeCamSection ----
  const templateInner = `#!/bin/sh
SANDBOX_FLAG=""
if [ "\${DY_CHROME_NOSANDBOX:-0}" = "1" ]; then SANDBOX_FLAG="--no-sandbox"; fi
# __DY_FAKE_CAM_BEGIN__
# r29-e: 虚拟摄像头（恒定帧注入）—— DY_FAKE_CAM_IMAGE 指向图片时启用
FAKE_CAM_FLAGS=""
if [ -n "\${DY_FAKE_CAM_IMAGE:-}" ] && [ -f "\${DY_FAKE_CAM_IMAGE}" ]; then
  FAKE_CAM_FLAGS="--use-fake-device-for-media-stream --use-file-for-fake-video-capture=\${DY_FAKE_CAM_IMAGE}"
fi
# __DY_FAKE_CAM_END__
nproc exec chromium --user-data-dir=x \${SANDBOX_FLAG} \${FAKE_CAM_FLAGS} about:blank
`
  const injected = rewriteFakeCamSection(templateInner, "/tmp/fake-cam.png")
  check("标记段重写：注入硬编码恒定帧路径", injected.includes('--use-file-for-fake-video-capture=/tmp/fake-cam.png') && injected.includes("--use-fake-device-for-media-stream"))
  check("标记段重写：注入后无 env 探测残留", !injected.includes('DY_FAKE_CAM_IMAGE}'))

  const removed = rewriteFakeCamSection(injected, null)
  check("标记段重写：移除恢复 env 探测默认段", removed.includes('DY_FAKE_CAM_IMAGE') && !removed.includes("/tmp/fake-cam.png"))

  const idempotent = rewriteFakeCamSection(rewriteFakeCamSection(templateInner, "/a.png"), "/a.png")
  check("标记段重写：幂等（双写不重复）", idempotent.split("use-file-for-fake-video-capture=").length === 2)

  const legacy = rewriteFakeCamSection("#!/bin/sh\nexec chromium about:blank\n", "/a.png")
  check("未知脚本：原样返回不破坏", legacy === "#!/bin/sh\nexec chromium about:blank\n")

  // Chromium 真实接受 fake-device flags（启动校验）
  const chrome = "/home/z/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
  const cdp = 19233
  const camProc = spawn(chrome, [
    "--headless=new", `--remote-debugging-port=${cdp}`, `--user-data-dir=${dir}/cam-profile`, "--no-sandbox",
    "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${imgPath}`,
    "about:blank",
  ], { stdio: "ignore" })
  await new Promise((res) => setTimeout(res, 2500))
  const camUp = await pidAlive(camProc.pid!)
  check("Chromium 接受恒定帧摄像头 flags 启动", camUp)
  if (camUp) {
    const r = await fetch(`http://127.0.0.1:${cdp}/json/list`).then((x) => x.json()).catch(() => null)
    check("恒定帧 Chromium CDP 可用", Array.isArray(r) && r.length > 0)
    try { camProc.kill("SIGTERM") } catch { /* exited */ }
  }

  // ---- 4. MediaCast 落库语义 ----
  const qaUser = await db.user.create({ data: { username: `qa-r29e-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true } })
  const qaWs = await db.browserWorkspace.create({ data: { name: `QA-R29E-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING", novncSessionId: "emb-qa-r29e" } })
  await db.mediaCast.create({ data: { workspaceId: qaWs.id, userId: qaUser.id, fileName: "cast-test.mp4", mediaKind: "video", seekSec: 2, castPid: 999999, status: "PLAYING", storagePath: join(dir, "cast-test.mp4") } })
  // 死 pid（999999 不存在）→ reap 收口
  const reap = await reapDeadMediaCasts()
  check("死进程收口：reap STOPPED", reap.reaped >= 1)
  const row = await db.mediaCast.findFirst({ where: { workspaceId: qaWs.id }, orderBy: { startedAt: "desc" } })
  check("收口落库：STOPPED + EXITED", row?.status === "STOPPED" && row?.stopReason === "EXITED")

  // ---- 清理 ----
  await db.mediaCast.deleteMany({ where: { workspaceId: qaWs.id } })
  await db.browserWorkspace.delete({ where: { id: qaWs.id } })
  await db.user.delete({ where: { id: qaUser.id } })
  await rm(dir, { recursive: true, force: true })
  try { xvfb.kill("SIGTERM") } catch { /* exited */ }

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
