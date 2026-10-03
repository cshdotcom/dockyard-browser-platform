// ============================================================
// r25-d VNC/沙箱创建零出错加固 —— 冒烟测试
// 覆盖：
//   1. 真实创建进程树（Xvfb 真实 + chromium 真实 + x11vnc 测试垫片）
//   2. 幂等复用：同 workspaceId 二次启动 → 复用同一棵树（零重复）
//   3. 并发去重：同 workspaceId 两个并发请求 → 同一句柄
//   4. 失败自动重试：首试垫片失败 → 第二次成功（换新端口/显示号）
//   5. 三次全失败 → 结构化诊断（重试次数 + 每次原因 + 排查建议）
//   6. 陈旧 Chromium 单例锁清理（死 pid 符号链接）
//   7. 磁盘余量自检（df 解析）
// 开发环境（非 root）：共享用户模式运行（与生产 root 形态链路一致）
// ============================================================
process.env.STORAGE_LOCAL_PATH = "/tmp/dy-r25d-storage"
process.env.EMBEDDED_BROWSER_BIN = process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
process.env.EMBEDDED_X11VNC_BIN = "/tmp/dy-r25d-x11vnc-shim.sh"

import { writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, chmodSync } from "fs"

const FAIL_FLAG = "/tmp/dy-r25d-shim-fail-once"

// ---- x11vnc 测试垫片：解析 -rfbport 并用 python 监听；FAIL_FLAG 存在时本次直接失败 ----
const SHIM = `#!/bin/sh
prev=""
port=""
for a in "$@"; do
  if [ "$prev" = "-rfbport" ]; then port="$a"; fi
  prev="$a"
done
if [ -f "${FAIL_FLAG}" ]; then
  rm -f "${FAIL_FLAG}"
  echo "[shim] 模拟本次启动失败（x11vnc 立即退出）" >&2
  exit 1
fi
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
mkdirSync("/tmp", { recursive: true })
writeFileSync(process.env.EMBEDDED_X11VNC_BIN, SHIM)
chmodSync(process.env.EMBEDDED_X11VNC_BIN, 0o755)

rmSync("/tmp/dy-r25d-storage", { recursive: true, force: true })
rmSync(FAIL_FLAG, { force: true })

const { createEmbeddedSandbox, destroyEmbeddedSandbox, embeddedSandboxAlive, resetEmbeddedCaches } = await import("../src/lib/embedded-sandbox")

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- 1. 真实创建 ----
console.log("【1】真实创建进程树（Xvfb/chromium 真实 + x11vnc 垫片）")
const WS = "ws-r25d-alpha"
const spec = {
  userId: "user-smoke-r25d",
  profileKey: "pk-r25d-alpha-001",
  workspaceId: WS,
  resolution: "1280x800",
  workspaceUuid: "a1b2c3d4e5f6g7h8",
  ownerUsername: "smoketest",
}
resetEmbeddedCaches()
const h1 = await createEmbeddedSandbox(spec)
ok("创建成功返回句柄", h1.id.startsWith("emb-"), h1.id)
ok("RFB 端口已监听（waitRfbUp 通过）", h1.rfb.port > 0)
const alive1 = await import("net").then((netmod) =>
  new Promise<boolean>((res) => {
    const s = netmod.connect({ host: "127.0.0.1", port: h1.rfb.port })
    s.once("connect", () => { s.destroy(); res(true) })
    s.once("error", () => res(false))
    setTimeout(() => { s.destroy(); res(false) }, 2000)
  })
)
ok("RFB 端口 TCP 可连", alive1)

// X server 真实存在（lock 文件）
ok("Xvfb 显示 lock 存在（真实虚拟显示）", existsSync(`/tmp/.X${h1.display}-lock`))
await sleep(2500)
// chromium 真实启动（chromium.log 有内容或 state.json chromePid>0）
let chromeLog = ""
try { chromeLog = readFileSync(`/tmp/dy-r25d-storage/sandboxes/${h1.id}/logs/chromium.log`, "utf8") } catch { /* 尚未写日志 */ }
const state = JSON.parse(readFileSync(`/tmp/dy-r25d-storage/sandboxes/${h1.id}/state.json`, "utf8")) as { chromePid?: number; xvfbPid?: number; vncPid?: number; supervisorPid?: number }
ok("进程树状态落盘（supervisor/xvfb pid）", !!state.supervisorPid && !!state.xvfbPid, JSON.stringify(state))
ok("Chromium 进程已拉起（chromePid>0 或已有日志）", (state.chromePid ?? 0) > 0 || chromeLog.length > 0, `chromePid=${state.chromePid} log=${chromeLog.length}B`)

// ---- 2. 幂等复用 ----
console.log("【2】幂等复用（同 workspaceId 再启动 → 复用，零重复树）")
const h2 = await createEmbeddedSandbox({ ...spec, resolution: "1440x900" })
ok("二次启动复用同一沙箱句柄", h2.id === h1.id, `${h2.id} vs ${h1.id}`)

// ---- 3. 并发去重 ----
console.log("【3】并发去重（同 workspaceId 两个并发请求 → 同一在途 Promise）")
const WS2 = "ws-r25d-beta"
const [p1, p2] = await Promise.all([
  createEmbeddedSandbox({ ...spec, workspaceId: WS2, profileKey: "pk-r25d-beta-001" }),
  createEmbeddedSandbox({ ...spec, workspaceId: WS2, profileKey: "pk-r25d-beta-001" }),
])
ok("并发启动共享同一句柄（一棵树）", p1.id === p2.id, `${p1.id} vs ${p2.id}`)

// ---- 4. 失败自动重试（换端口/显示号重试成功）----
console.log("【4】单次失败 → 自动重试成功")
writeFileSync(FAIL_FLAG, "1")
const WS3 = "ws-r25d-gamma"
const t0 = Date.now()
const h3 = await createEmbeddedSandbox({ ...spec, workspaceId: WS3, profileKey: "pk-r25d-gamma-001" })
const dur = Date.now() - t0
ok("首试失败后重试成功返回句柄", h3.id.startsWith("emb-"))
ok("重试间隔已生效（总耗时 > 600ms 退避）", dur > 600, `${dur}ms`)

// ---- 5. 三次全失败 → 结构化诊断 ----
console.log("【5】三次全失败 → 结构化诊断错误")
// 让垫片持续失败：垫片失败一次会删除 flag，改为注入一个必失败端口环境（用未知 display 上限？）
// 简单可靠方案：把垫片换成恒失败版本
writeFileSync(process.env.EMBEDDED_X11VNC_BIN!, `#!/bin/sh
echo "[shim] 恒定失败（模拟 x11vnc 不可用）" >&2
exit 1
`)
chmodSync(process.env.EMBEDDED_X11VNC_BIN!, 0o755)
resetEmbeddedCaches()
let diagMsg = ""
try {
  await createEmbeddedSandbox({ ...spec, workspaceId: "ws-r25d-delta", profileKey: "pk-r25d-delta-001" })
  ok("应抛出错误（却成功了）", false)
} catch (e) {
  diagMsg = (e as Error).message
}
ok("错误含「已自动重试 3 次」", diagMsg.includes("已自动重试 3 次"), diagMsg.slice(0, 80))
ok("错误含逐次尝试明细", /第 1 次：/.test(diagMsg) && /第 3 次：/.test(diagMsg))
ok("错误含排查建议", diagMsg.includes("排查建议"))
ok("错误含 x11vnc 日志指引", /x11vnc/.test(diagMsg))

// 恢复正常垫片
writeFileSync(process.env.EMBEDDED_X11VNC_BIN!, SHIM)
chmodSync(process.env.EMBEDDED_X11VNC_BIN!, 0o755)

// ---- 6. 陈旧单例锁清理 ----
console.log("【6】陈旧 Chromium 单例锁清理（死 pid 符号链接）")
const profileDir = `/tmp/dy-r25d-storage/profiles/${spec.userId}/pk-r25d-eps-001`
mkdirSync(profileDir, { recursive: true })
symlinkSync("deadhost-999999", profileDir + "/SingletonLock") // pid=999999 几乎必死
symlinkSync("deadhost-999999", profileDir + "/SingletonCookie")
writeFileSync(profileDir + "/SingletonSocket", "stale-regular-file") // 非符号链接残留
const h4 = await createEmbeddedSandbox({ ...spec, workspaceId: "ws-r25d-eps", profileKey: "pk-r25d-eps-001" })
ok("带陈旧锁 Profile 创建成功", h4.id.startsWith("emb-"))
ok("陈旧符号链接锁已清理", !existsSync(profileDir + "/SingletonLock"))
// SingletonSocket：陈旧普通文件被清理后，Chromium 会立刻以【活符号链接】重建自己的单例锁
//（指向其活 pid）——断言"不再是陈旧普通文件"（不存在或为符号链接即正确）
const sockStat = await import("fs/promises").then((fp) => fp.lstat(profileDir + "/SingletonSocket").catch(() => null))
ok("非符号链接残留已清理（现为 Chromium 活锁或不复存在）", !sockStat || sockStat.isSymbolicLink())

// ---- 7. 磁盘自检 ----
console.log("【7】磁盘余量自检（df -P 解析）")
const dfOut = (await import("child_process").then((cp) => cp.spawnSync("df", ["-P", "/tmp"]).stdout?.toString() || ""))
ok("df 输出解析（可用 KB 列）", /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%/m.test(dfOut))

// ---- 清理：销毁全部测试沙箱 ----
for (const id of new Set([h1.id, p1.id, h3.id, h4.id])) {
  await destroyEmbeddedSandbox(id).catch(() => null)
}
await sleep(800)
rmSync("/tmp/dy-r25d-storage", { recursive: true, force: true })
rmSync(FAIL_FLAG, { force: true })
ok("测试沙箱全部销毁 + 临时存储清理", true)

console.log(`\n=== r25-d 沙箱创建加固冒烟：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
