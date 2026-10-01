// ============================================================
// r13 单容器全内置（嵌入式沙箱运行时）— 引擎级真实 E2E 测试
// 前置：本机解包 chromium/x11vnc deb（apt-get download + dpkg -x）
// 验证链路（全部真实进程，无任何模拟）：
//   1. createEmbeddedSandbox：Xvfb + x11vnc + Chromium 进程树拉起
//   2. RFB 3.8 完整握手 + raw 帧缓冲抓取 → PNG（VNC 通道真实渲染证明）
//   3. CDP：/json/version + 页面导航 + Page.captureScreenshot → PNG
//   4. state.json 状态落盘（supervisorPid/chromePid/端口/display）
//   5. USR1 进程级重启：同一 Profile 重新拉起 + CDP 恢复
//   6. embeddedSandboxStats（真实 /proc 采样）+ 日志
//   7. 销毁：进程树级联终止 + 端口释放
// ============================================================

import net from "net"
import fs from "fs"
import zlib from "zlib"
import { join } from "path"

// ---- 二进制注入（开发环境：解包 deb 的真实组件）----
const R = "/home/z/dy-root"
process.env.EMBEDDED_BROWSER_BIN = `${R}/usr/lib/chromium/chromium`
process.env.EMBEDDED_X11VNC_BIN = `${R}/usr/bin/x11vnc`
process.env.LD_LIBRARY_PATH = `${R}/usr/lib/x86_64-linux-gnu:${R}/usr/lib/chromium`
process.env.STORAGE_LOCAL_PATH = "/home/z/my-project/storage"

const OUT = "/home/z/my-project/qa/embedded"
fs.mkdirSync(OUT, { recursive: true })

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? " — " + extra : ""}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`)
  }
}

// ============================================================
// PNG 编码器（纯 node：zlib + CRC32）
// ============================================================
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeB = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])))
  return Buffer.concat([len, typeB, data, crc])
}
function encodePng(rgba: Buffer, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ============================================================
// RFB 3.8 客户端（握手 + raw 帧缓冲整屏请求）
// ============================================================
interface RfbShot { w: number; h: number; rgba: Buffer; serverName: string }
async function rfbGrabFrame(host: string, port: number, timeoutMs = 15000): Promise<RfbShot> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port })
    const chunks: Buffer[] = []
    let buf = Buffer.alloc(0)
    let W = 0
    let H = 0
    let bpp = 0
    let redShift = 0
    let greenShift = 0
    let blueShift = 0
    let serverName = ""
    let phase: "banner" | "sectypes" | "sectypes2" | "secresult" | "serverinit" | "serverinit2" | "update" | "recthdr" | "rectdata" = "banner"
    let pending = 12
    let rectsLeft = 0
    let rects: Array<{ x: number; y: number; w: number; h: number }> = []
    let rgba = Buffer.alloc(0)
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error(`RFB 超时（phase=${phase}）`))
    }, timeoutMs)
    type Phase = "banner" | "sectypes" | "sectypes2" | "secresult" | "serverinit" | "serverinit2" | "update" | "recthdr" | "rectdata"
    const fail = (m: string) => {
      clearTimeout(timer)
      s.destroy()
      reject(new Error(m))
    }
    const step = () => {
      while (buf.length >= pending) {
        const frame = buf.subarray(0, pending)
        buf = buf.subarray(pending)
        switch (phase) {
          case "banner": {
            const banner = frame.toString("ascii").trim()
            if (!banner.startsWith("RFB 003.00")) return fail(`异常 RFB 版本: ${banner}`)
            s.write("RFB 003.008\n")
            phase = "sectypes"
            pending = 1 // 数量字节
            break
          }
          case "sectypes": {
            const n = frame[0]
            if (n === 0) return fail("服务端无可用安全类型")
            pending = n
            phase = "sectypes2"
            break
          }
          case "sectypes2": {
            const types = Array.from(frame)
            const pick = types.includes(1) ? 1 : types[0]
            s.write(Buffer.from([pick]))
            phase = "secresult"
            pending = 4 // SecurityResult（3.8 协议）
            break
          }
          case "secresult": {
            const res = frame.readUInt32BE(0)
            if (res !== 0) return fail(`安全握手失败 result=${res}`)
            s.write(Buffer.from([1])) // ClientInit shared=1
            phase = "serverinit"
            pending = 24 // 2+2+16+4（name len）
            break
          }
          case "serverinit": {
            W = frame.readUInt16BE(0)
            H = frame.readUInt16BE(2)
            bpp = frame[4]
            // 像素格式字段本身始终大端（bigEndian 标志仅描述像素字节序）
            const rm = frame.readUInt16BE(8)
            if (rm !== 255) return fail(`未预期的颜色深度 redMax=${rm}（需 raw 8bit/channel）`)
            redShift = frame[12]
            greenShift = frame[13]
            blueShift = frame[14]
            const nameLen = frame.readUInt32BE(20)
            serverName = ""
            phase = "serverinit2"
            pending = nameLen
            break
          }
          case "serverinit2": {
            serverName = frame.toString("utf8")
            // SetEncodings: raw(0)
            const setEnc = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])
            s.write(setEnc)
            // FramebufferUpdateRequest: 全屏非增量
            const req = Buffer.alloc(10)
            req[0] = 3
            req[1] = 0
            req.writeUInt16BE(0, 2)
            req.writeUInt16BE(0, 4)
            req.writeUInt16BE(W, 6)
            req.writeUInt16BE(H, 8)
            s.write(req)
            phase = "update"
            pending = 4 // 类型 + padding + rect 数
            break
          }
          case "update": {
            const msgType = frame[0]
            if (msgType !== 0) {
              // 其他消息（Bell=2 / ServerCutText=3）跳过
              pending = 1
              break
            }
            rectsLeft = frame.readUInt16BE(2)
            if (rectsLeft === 0) return fail("空更新")
            rects = []
            rgba = Buffer.alloc(W * H * 4)
            phase = "recthdr"
            pending = 12
            break
          }
          case "recthdr": {
            const x = frame.readUInt16BE(0)
            const y = frame.readUInt16BE(2)
            const w = frame.readUInt16BE(4)
            const h = frame.readUInt16BE(6)
            const enc = frame.readInt32BE(8)
            if (enc !== 0) return fail(`非 raw 编码: ${enc}`)
            rects.push({ x, y, w, h })
            phase = "rectdata"
            pending = w * h * Math.ceil(bpp / 8)
            break
          }
          case "rectdata": {
            const r = rects[rects.length - 1]
            const bypp = bpp / 8
            for (let row = 0; row < r.h; row++) {
              for (let col = 0; col < r.w; col++) {
                const src = frame.readUInt32LE(row * r.w * bypp + col * bypp)
                const dst = ((r.y + row) * W + (r.x + col)) * 4
                rgba[dst] = (src >>> redShift) & 0xff
                rgba[dst + 1] = (src >>> greenShift) & 0xff
                rgba[dst + 2] = (src >>> blueShift) & 0xff
                rgba[dst + 3] = 255
              }
            }
            rectsLeft--
            if (rectsLeft > 0) {
              phase = "recthdr"
              pending = 12
            } else {
              clearTimeout(timer)
              s.destroy()
              resolve({ w: W, h: H, rgba, serverName })
              return
            }
            break
          }
          default:
            break
        }
      }
    }
    s.on("data", (d) => {
      chunks.push(d)
      buf = Buffer.concat([buf, ...chunks.splice(0)])
      step()
    })
    s.on("error", (e) => fail(e.message))
  })
}

// ============================================================
// CDP 客户端（ws：导航 + 截图）
// ============================================================
async function cdpScreenshot(port: number, url: string, outPng: string): Promise<boolean> {
  const WebSocket = (await import("ws")).default
  let list: Array<{ type: string; webSocketDebuggerUrl: string }> = []
  try {
    list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json() as Promise<Array<{ type: string; webSocketDebuggerUrl: string }>>)
  } catch {
    return false
  }
  const page = list.find((t) => t.type === "page")
  if (!page) return false
  return new Promise((resolve) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 8000 })
    let id = 0
    const pendingMap = new Map<number, (v: unknown) => void>()
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((res) => {
        const i = ++id
        pendingMap.set(i, res)
        ws.send(JSON.stringify({ id: i, method, params }))
      })
    const timer = setTimeout(() => {
      ws.terminate()
      resolve(false)
    }, 20000)
    ws.on("open", async () => {
      await call("Page.enable")
      await call("Page.navigate", { url })
      await new Promise((r) => setTimeout(r, 3500))
      const shot = (await call("Page.captureScreenshot", { format: "png" })) as { data?: string } | undefined
      if (shot?.data) {
        fs.writeFileSync(outPng, Buffer.from(shot.data, "base64"))
        clearTimeout(timer)
        ws.close()
        resolve(true)
      } else {
        clearTimeout(timer)
        ws.terminate()
        resolve(false)
      }
    })
    ws.on("message", (m) => {
      try {
        const msg = JSON.parse(m.toString()) as { id?: number; result?: unknown }
        if (msg.id && pendingMap.has(msg.id)) {
          pendingMap.get(msg.id)!(msg.result)
          pendingMap.delete(msg.id)
        }
      } catch {
        /* ignore */
      }
    })
    ws.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ Browser?: string }>)
    return !!v.Browser
  } catch {
    return false
  }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const { createEmbeddedSandbox, embeddedSandbox, embeddedSandboxStats, embeddedSandboxLogs, restartEmbeddedBrowser, destroyEmbeddedSandbox, embeddedSandboxAlive, resolveBrowserRuntimeMode } =
    await import("../src/lib/embedded-sandbox")

  console.log("── 0. 运行时形态解析")
  const mode = resolveBrowserRuntimeMode()
  ok("BROWSER_RUNTIME=auto 解析为 embedded", mode.mode === "embedded", mode.reason)

  // 每沙箱策略文件（引擎创建时引用；容器内经 unshare 私有挂载命名空间注入）
  fs.mkdirSync("/home/z/my-project/storage/netpolicy", { recursive: true })
  fs.writeFileSync(
    "/home/z/my-project/storage/netpolicy/ws-qaprofile01.json",
    JSON.stringify({ URLBlocklist: ["*.forbidden-domain-qa.invalid"], DownloadRestrictions: 2 }, null, 2),
  )

  const QA_PAGE = `data:text/html,<html><body style="margin:0;background:%23071820;display:flex;align-items:center;justify-content:center"><div style="font-family:monospace;font-size:64px;color:%2300e5a0;font-weight:bold">DOCKYARD<br>EMBEDDED SANDBOX<br>QA r13</div></body></html>`

  console.log("── 1. 创建嵌入式沙箱（真实进程树）")
  const sb = await createEmbeddedSandbox({
    userId: "qauser0001",
    profileKey: "qaprofile01",
    resolution: "1280x800",
    startUrl: QA_PAGE,
    memLimitMb: 1024,
    pidsLimit: 256,
    policyFile: "/home/z/my-project/storage/netpolicy/ws-qaprofile01.json",
  })
  ok("沙箱句柄返回", !!sb.id && sb.rfb.port > 0 && sb.cdpPort > 0 && sb.display > 0, `id=${sb.id} display=:${sb.display} rfb=${sb.rfb.port} cdp=${sb.cdpPort}`)
  ok("硬隔离快照（embedded 形态）", (sb.hardening as unknown as { runtime?: string }).runtime === "embedded" && sb.hardening.supervisorLoop === true)

  console.log("── 2. state.json 状态落盘")
  const state = JSON.parse(fs.readFileSync(join("/home/z/my-project/storage/sandboxes", sb.id, "state.json"), "utf8"))
  ok("监督进程 PID 落盘", state.supervisorPid > 1, `supervisor=${state.supervisorPid} chrome=${state.chromePid}`)
  ok("浏览器进程 PID 落盘", state.chromePid > 1)
  ok("端口/display 与句柄一致", state.rfbPort === sb.rfb.port && state.cdpPort === sb.cdpPort && state.display === sb.display)
  ok("re-adopt（另一进程上下文读取）", !!(await embeddedSandbox(sb.id)))

  console.log("── 3. CDP 真实链路")
  let cdpReady = false
  for (let i = 0; i < 30 && !cdpReady; i++) {
    cdpReady = await cdpAlive(sb.cdpPort)
    if (!cdpReady) await new Promise((r) => setTimeout(r, 500))
  }
  ok("CDP /json/version", cdpReady)
  const cdpShotOk = await cdpScreenshot(sb.cdpPort, QA_PAGE, join(OUT, "qa-embedded-cdp.png"))
  ok("CDP Page.captureScreenshot", cdpShotOk, "qa/embedded/qa-embedded-cdp.png")

  console.log("── 4. VNC(RFB) 真实帧缓冲")
  const shot = await rfbGrabFrame("127.0.0.1", sb.rfb.port)
  ok("RFB 分辨率 1280x800", shot.w === 1280 && shot.h === 800, `${shot.w}x${shot.h} server="${shot.serverName.slice(0, 40)}"`)
  fs.writeFileSync(join(OUT, "qa-embedded-vnc.png"), encodePng(shot.rgba, shot.w, shot.h))
  // 非纯黑像素统计（证明真实渲染而非黑屏）
  let colored = 0
  for (let i = 0; i < shot.rgba.length; i += 4) {
    if (shot.rgba[i] + shot.rgba[i + 1] + shot.rgba[i + 2] > 30) colored++
  }
  ok("RFB 帧缓冲含真实内容（非黑屏）", colored > shot.w * shot.h * 0.02, `彩色像素 ${colored}（${((colored / (shot.w * shot.h)) * 100).toFixed(1)}%）`)

  console.log("── 5. 健康探测 / 统计 / 日志（真实 /proc）")
  const entry = await embeddedSandbox(sb.id)
  ok("监督进程存活", !!entry && embeddedSandboxAlive(entry!))
  const st = await embeddedSandboxStats(sb.id)
  ok("真实资源统计", !!st && st!.memMb > 5 && st!.uptimeSec > 0, st ? `mem=${st.memMb}MB uptime=${st.uptimeSec}s` : "")
  const logs = await embeddedSandboxLogs(sb.id, 30)
  ok("监督日志非空", logs.length > 0, logs[logs.length - 1]?.slice(0, 70))

  console.log("── 6. USR1 进程级重启（同一 Profile）")
  const chromeBefore = state.chromePid
  const r = await restartEmbeddedBrowser(sb.id)
  ok("USR1 已发送", r.restarted)
  let chromeAfter = 0
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 500))
    const s2 = JSON.parse(fs.readFileSync(join("/home/z/my-project/storage/sandboxes", sb.id, "state.json"), "utf8"))
    if (s2.chromePid > 1 && s2.chromePid !== chromeBefore) {
      chromeAfter = s2.chromePid
      break
    }
  }
  ok("浏览器以新 PID 重启（同一 Profile）", chromeAfter > 0 && chromeAfter !== chromeBefore, `pid ${chromeBefore} → ${chromeAfter}`)
  ok("重启后 CDP 恢复", await cdpAlive(sb.cdpPort))
  ok("重启后 RFB 通道恢复", !!(await rfbGrabFrame("127.0.0.1", sb.rfb.port).catch(() => null)))

  console.log("── 7. 销毁（级联终止）")
  const supervisorPid = state.supervisorPid
  await destroyEmbeddedSandbox(sb.id)
  await new Promise((res) => setTimeout(res, 1500))
  const aliveAfter = (() => {
    try {
      process.kill(supervisorPid, 0)
      return true
    } catch {
      return false
    }
  })()
  ok("监督进程已终止", !aliveAfter)
  ok("RFB 端口已释放", await new Promise<boolean>((res) => {
    const s = net.connect({ host: "127.0.0.1", port: sb.rfb.port })
    s.once("connect", () => { s.destroy(); res(false) })
    s.once("error", () => res(true))
  }))
  ok("CDP 端口已释放", await new Promise<boolean>((res) => {
    const s = net.connect({ host: "127.0.0.1", port: sb.cdpPort })
    s.once("connect", () => { s.destroy(); res(false) })
    s.once("error", () => res(true))
  }))
  ok("沙箱目录已清理", !fs.existsSync(join("/home/z/my-project/storage/sandboxes", sb.id)))

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error("致命错误：", e)
  process.exit(1)
})
