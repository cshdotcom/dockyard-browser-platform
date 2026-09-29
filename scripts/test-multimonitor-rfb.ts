// HelmPort 多监视器分辨率切换协议验证（RFB SetDesktopSize / ExtendedDesktopSize）
// 直连网关桥演示引擎：验证单屏分辨率切换 / 双屏布局 / 无效尺寸拒绝 / 帧随新尺寸输出
import { createHmac } from "node:crypto"
import { HelmPortRfb, EDS_RESULT_SUCCESS, type RfbDesktopSize } from "../src/components/vnc/helmport/rfb-client"

process.on("uncaughtException", (e) => {
  console.log("[uncaughtException 兜底]", (e as Error).message?.slice(0, 80))
})

const b64url = (b: Buffer) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const secret = process.env.VNC_BRIDGE_SECRET || "dockyard-dev-vnc-secret"
const workspaceId = "multimonitor-test"
const payload = { v: workspaceId, ro: 0, exp: Math.floor(Date.now() / 1000) + 120, n: "mm-" + Date.now(), tgt: { k: "demo" } }
const pb = b64url(Buffer.from(JSON.stringify(payload)))
const sig = b64url(createHmac("sha256", secret).update(pb).digest())
const ticket = `${pb}.${sig}`

const fakeCanvas = {
  width: 0,
  height: 0,
  style: {} as Record<string, string>,
  getContext: () => null,
} as unknown as HTMLCanvasElement

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const events: { size: RfbDesktopSize; framesAfter: number }[] = []
let lastFrameCount = 0
const ws = new WebSocket(`ws://127.0.0.1:3005/?vnc=${workspaceId}&ticket=${encodeURIComponent(ticket)}`)
ws.binaryType = "arraybuffer"

let currentRfb: HelmPortRfb | null = null
const state: { size: RfbDesktopSize | null; frames: number; canvasW: number; canvasH: number } = {
  size: null, frames: 0, canvasW: 0, canvasH: 0,
}

const rfb = new HelmPortRfb(ws, {
  canvas: fakeCanvas,
  viewOnly: false,
  qualityLevel: 9,
  onConnected: (info) => {
    console.log(`[connected] ${info.width}x${info.height}`)
    state.canvasW = info.width
    state.canvasH = info.height
    step1()
  },
  onDesktopSize: (size) => {
    state.size = size
    state.canvasW = fakeCanvas.width
    state.canvasH = fakeCanvas.height
    console.log(`[onDesktopSize] result=${size.resultCode} ${size.width}x${size.height} screens=${size.screens.length} (canvas ${fakeCanvas.width}x${fakeCanvas.height})`)
    events.push({ size, framesAfter: 0 })
  },
  onTelemetry: (t) => {
    state.frames = t.frameCount
  },
  onDisconnected: (reason) => {
    console.log("[disconnected]", reason)
  },
  onSecurityFail: (reason) => {
    console.error("[securityFail]", reason)
  },
})
currentRfb = rfb

// 代理 canvas 尺寸断言（rfb-client 直接写 canvas.width/height）
const canvasTarget = fakeCanvas as { width: number; height: number }

function step1() {
  // 初始布局宣告（连接后服务端在 SetEncodings 含 EDS 时发送）
  setTimeout(() => {
    ok("初始布局宣告到达（单屏 640×400）", !!state.size && state.size.resultCode === EDS_RESULT_SUCCESS && state.size.width === 640, JSON.stringify(state.size?.screens))
    step2()
  }, 800)
}

function step2() {
  // 单屏分辨率切换：1280×720
  const sent = rfb.sendSetDesktopSize(1280, 720, [{ id: 0, x: 0, y: 0, width: 1280, height: 720, flags: 0 }])
  ok("SetDesktopSize(1280×720) 已发送", sent)
  setTimeout(() => {
    ok("单屏切换确认 result=0 且 1280×720", state.size?.resultCode === 0 && state.size?.width === 1280 && state.size?.height === 720)
    ok("画布随服务端确认调整为 1280×720", canvasTarget.width === 1280 && canvasTarget.height === 720)
    const framesAt1280 = state.frames
    setTimeout(() => {
      ok("1280×720 下持续出帧", state.frames > framesAt1280, `frames ${framesAt1280} → ${state.frames}`)
      step3()
    }, 1600)
  }, 700)
}

function step3() {
  // 双监视器布局：2×1280×720 → 总帧缓冲 2560×720
  const sent = rfb.sendSetDesktopSize(2560, 720, [
    { id: 0, x: 0, y: 0, width: 1280, height: 720, flags: 0 },
    { id: 1, x: 1280, y: 0, width: 1280, height: 720, flags: 0 },
  ])
  ok("SetDesktopSize(双屏 2560×720) 已发送", sent)
  setTimeout(() => {
    ok("双屏布局确认 result=0 且 2560×720", state.size?.resultCode === 0 && state.size?.width === 2560 && state.size?.height === 720)
    ok("双屏 screens=2 且边界正确", state.size?.screens.length === 2 && state.size?.screens[1]?.x === 1280 && state.size?.screens[1]?.width === 1280)
    ok("画布调整为 2560×720", canvasTarget.width === 2560 && canvasTarget.height === 720)
    step4()
  }, 700)
}

function step4() {
  // 三屏 3×1280×720 → 3840×720
  rfb.sendSetDesktopSize(3840, 720, [
    { id: 0, x: 0, y: 0, width: 1280, height: 720, flags: 0 },
    { id: 1, x: 1280, y: 0, width: 1280, height: 720, flags: 0 },
    { id: 2, x: 2560, y: 0, width: 1280, height: 720, flags: 0 },
  ])
  setTimeout(() => {
    ok("三屏布局确认 3840×720 × 3 屏", state.size?.width === 3840 && state.size?.screens.length === 3)
    const framesBefore = state.frames
    setTimeout(() => {
      ok("多屏下帧持续输出（宽度 3840）", state.frames > framesBefore, `frames ${framesBefore} → ${state.frames}`)
      step5()
    }, 1500)
  }, 700)
}

function step5() {
  // 无效尺寸（过小 100×100）→ 服务端拒绝 result=2（INVALID）
  // 客户端会本地拒绝 → 绕过客户端守卫直接发原始报文验证服务端校验
  const sentLocal = rfb.sendSetDesktopSize(100, 100, [{ id: 0, x: 0, y: 0, width: 100, height: 100, flags: 0 }])
  ok("客户端本地拒绝超小尺寸", sentLocal === false)
  const msg = new Uint8Array(7 + 16)
  msg[0] = 8
  msg[1] = 0; msg[2] = 100
  msg[3] = 0; msg[4] = 100
  msg[5] = 1
  ws.send(msg)
  setTimeout(() => {
    ok("服务端拒绝无效尺寸 result=2", state.size?.resultCode === 2, `当前尺寸保持 ${state.size?.width}×${state.size?.height}`)
    ok("拒绝后画布保持原尺寸", canvasTarget.width === 3840)
    // 客户端参数校验：范围外直接拒绝发送
    ok("客户端本地拒绝超范围尺寸", rfb.sendSetDesktopSize(9999, 9999, [{ id: 0, x: 0, y: 0, width: 9999, height: 9999, flags: 0 }]) === false)
    readonlyTest()
  }, 700)
}

// 只读会话：服务端拒绝调整（result=1 PROHIBITED）
function readonlyTest() {
  const roPayload = { v: workspaceId + "-ro", ro: 1, exp: Math.floor(Date.now() / 1000) + 60, n: "ro-" + Date.now(), tgt: { k: "demo" } }
  const rpb = b64url(Buffer.from(JSON.stringify(roPayload)))
  const rsig = b64url(createHmac("sha256", secret).update(rpb).digest())
  const roTicket = `${rpb}.${rsig}`

  const roWs = new WebSocket(`ws://127.0.0.1:3005/?vnc=${workspaceId}-ro&ticket=${encodeURIComponent(roTicket)}`)
  roWs.binaryType = "arraybuffer"
  let roSize: RfbDesktopSize | null = null
  const roRfb = new HelmPortRfb(roWs, {
    canvas: { ...fakeCanvas } as unknown as HTMLCanvasElement,
    viewOnly: true,
    qualityLevel: 5,
    onConnected: () => {
      setTimeout(() => {
        // viewOnly 客户端本地就应拒绝
        const sent = roRfb.sendSetDesktopSize(1920, 1080, [{ id: 0, x: 0, y: 0, width: 1920, height: 1080, flags: 0 }])
        ok("只读客户端本地拒绝分辨率切换", sent === false)
        // 绕过客户端守卫直接发原始报文（服务端必须二次拒绝）
        const msg = new Uint8Array(7 + 16)
        msg[0] = 8
        msg[1] = 1920 >> 8; msg[2] = 1920 & 0xff
        msg[3] = 1080 >> 8; msg[4] = 1080 & 0xff
        msg[5] = 1
        roWs.send(msg)
      }, 700)
    },
    onDesktopSize: (size) => { roSize = size },
    onDisconnected: () => {},
  })
  setTimeout(() => {
    ok("只读会话服务端拒绝调整（result=1）", roSize?.resultCode === 1, JSON.stringify(roSize?.screens?.length))
    try { roRfb.disconnect() } catch { /* noop */ }
    finish()
  }, 2200)
}

function finish() {
  try { rfb.disconnect() } catch { /* noop */ }
  setTimeout(() => {
    console.log(`\n========== 多监视器协议验证：${pass} 通过 / ${fail} 失败 ==========`)
    if (fail > 0) {
      failures.forEach((f) => console.log("  - " + f))
      process.exit(1)
    }
    process.exit(0)
  }, 400)
}

// 全局超时兜底
setTimeout(() => {
  console.log("!! 全局超时")
  process.exit(1)
}, 25000)
