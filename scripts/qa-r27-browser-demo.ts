// r27 浏览器实测辅助：留下一份真实录像数据（不清理）供 UI 回放验证
// 用后运行 cleanup：bunx tsx scripts/qa-r27-browser-cleanup.ts
process.env.EMBEDDED_BROWSER_BIN = process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
process.env.EMBEDDED_X11VNC_BIN = "/tmp/dy-r27e-x11vnc-shim.sh"
import { writeFileSync, chmodSync } from "fs"
const SHIM = `#!/bin/sh
prev=""; port=""
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

const { PrismaClient } = require("@prisma/client")
const db = new PrismaClient()

async function main() {
  const { createEmbeddedSandbox, destroyEmbeddedSandbox } = await import("../src/lib/embedded-sandbox")
  const { registerWorkspaceRecording, finalizeRecordingSession } = await import("../src/lib/recording")

  // demo 用户（浏览器已登录 admin；录像归 demo 用户 → 管理员后台跨用户可见性正好验证 RBAC）
  const demo = await db.user.findFirst({ where: { username: "demo", deletedAt: null } })
  if (!demo) throw new Error("demo 用户不存在（先 bun prisma/seed.ts）")
  const wsUuid = "wsui" + Date.now().toString(36)
  const ws = await db.browserWorkspace.create({
    data: { name: "QA-R27UI-回放演示", uuid: wsUuid, mode: "novnc_full", status: "RUNNING", userId: demo.id },
  })
  const sb = await createEmbeddedSandbox({
    userId: demo.id,
    profileKey: "p-ui" + Date.now().toString(36),
    workspaceId: ws.id,
    resolution: "1024x768",
    startUrl: "about:blank",
    recording: { enabled: true, fps: 10, segmentSec: 6, maxSec: 0 },
    exitGuard: "fullscreen",
  })
  await registerWorkspaceRecording({
    workspace: { id: ws.id, uuid: wsUuid, name: ws.name, userId: demo.id },
    username: "demo",
    sessionId: sb.id,
    resolution: "1024x768",
    policy: { enabled: true, source: "USER", resolvedAt: new Date().toISOString() },
    tuning: { fps: 10, segmentSec: 6, maxMinutes: 0, maxSegmentMb: 2048 },
  })
  console.log("录制中 12 秒…")
  await new Promise((r) => setTimeout(r, 12000))
  await destroyEmbeddedSandbox(sb.id)
  await new Promise((r) => setTimeout(r, 1500))
  await finalizeRecordingSession(sb.id, { reason: "ui-demo" })
  const rows = await db.vncRecording.findMany({ where: { sessionId: sb.id } })
  console.log("UI 演示数据就绪：", JSON.stringify(rows.map((r) => ({ seg: r.segmentIndex, status: r.status, dur: r.durationSec, size: r.sizeBytes, id: r.id }))))
  console.log("SESSION_DIR:", `storage/recordings/${demo.id}/${sb.id}`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
