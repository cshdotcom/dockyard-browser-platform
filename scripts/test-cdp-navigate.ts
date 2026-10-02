// 沙箱浏览器 CDP 导航测试：让真实 chromium 打开网页，验证 VNC 桌面同步
const WS_URL = process.argv[2]
const TARGET_URL = process.argv[3] || "https://example.com"

const ws = new WebSocket(WS_URL)
let id = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  })
}

ws.onopen = async () => {
  try {
    await send("Page.enable")
    const nav = await send("Page.navigate", { url: TARGET_URL })
    console.log("navigate result:", JSON.stringify(nav).slice(0, 200))
    await new Promise((r) => setTimeout(r, 4000))
    const res = await send("Runtime.evaluate", { expression: "document.title + ' | ' + location.href" })
    console.log("页面:", JSON.stringify(res.result?.result?.value))
    ws.close()
    process.exit(0)
  } catch (e) {
    console.error("FAIL:", e.message)
    process.exit(1)
  }
}
ws.onerror = (e) => { console.error("WS error"); process.exit(1) }
