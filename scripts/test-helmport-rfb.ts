// HelmPort 自研 RFB 客户端协议验证（Node 直连网关桥，复现浏览器侧握手）
import { createHmac } from "node:crypto"
import { HelmPortRfb } from "../src/components/vnc/helmport/rfb-client"

// Bun 的 WebStreams→Node 适配器偶发以事件形式抛流错误（浏览器侧为可捕获 Promise 拒绝）
process.on("uncaughtException", (e) => {
  console.log("[uncaughtException 兜底]", (e as Error).message?.slice(0, 80))
})

const b64url = (b: Buffer) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const secret = process.env.VNC_BRIDGE_SECRET || "dockyard-dev-vnc-secret"
const workspaceId = "helmport-node-test"
const payload = { v: workspaceId, ro: 0, exp: Math.floor(Date.now() / 1000) + 60, n: "node-" + Date.now(), tgt: { k: "demo" } }
const pb = b64url(Buffer.from(JSON.stringify(payload)))
const sig = b64url(createHmac("sha256", secret).update(pb).digest())
const ticket = `${pb}.${sig}`

// 画布桩（Node 无 DOM canvas；客户端对 ctx=null 已空安全）
const fakeCanvas = {
  width: 0,
  height: 0,
  style: {} as Record<string, string>,
  getContext: () => null,
} as unknown as HTMLCanvasElement

const logs: string[] = []
const ws = new WebSocket(`ws://127.0.0.1:3005/?vnc=${workspaceId}&ticket=${encodeURIComponent(ticket)}`)
ws.binaryType = "arraybuffer"

const rfb = new HelmPortRfb(ws, {
  canvas: fakeCanvas,
  viewOnly: false,
  qualityLevel: 5,
  onConnected: (info) => {
    logs.push(`CONNECTED ${info.width}x${info.height} name=${info.name} v=${info.version}`)
    console.log("[onConnected]", info)
    // 输入注入：指针移动 + 点击 + 按键
    rfb.sendPointer(100, 100, 0)
    rfb.sendPointer(100, 100, 1)
    rfb.sendPointer(100, 100, 0)
    rfb.sendKey(0x41, true) // 'A'
    rfb.sendKey(0x41, false)
    // 剪贴板（QEMU 扩展）
    setTimeout(async () => {
      const channel = await rfb.sendClipboard("中文剪贴板往返验证-Clipboard-Test")
      console.log("[clipboard] channel:", channel)
    }, 600)
  },
  onClipboard: (text) => console.log("[onClipboard] 收到:", JSON.stringify(text.slice(0, 60))),
  onDisconnected: (reason) => {
    logs.push(`DISCONNECTED: ${reason}`)
    console.log("[onDisconnected]", reason)
  },
  onSecurityFail: (reason) => {
    logs.push(`SECURITY_FAIL: ${reason}`)
    console.error("[onSecurityFail]", reason)
  },
  onTelemetry: (t) => {
    if (t.frameCount % 20 === 0) console.log("[telemetry] frames=", t.frameCount, "bytesIn=", t.bytesIn, "bytesOut=", t.bytesOut)
  },
})

setTimeout(() => {
  console.log("\n==== 结果 ====")
  console.log(logs.join("\n"))
  rfb.disconnect()
  setTimeout(() => process.exit(0), 300)
}, 5000)
