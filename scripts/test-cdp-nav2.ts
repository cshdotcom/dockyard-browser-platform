// 沙箱浏览器 CDP 导航（Node 原生 ws 客户端版）
const WS_URL = process.argv[2]
const TARGET_URL = process.argv[3] || "https://example.com"

async function main() {
  const { WebSocket } = await import("ws")
  const ws = new WebSocket(WS_URL, { perMessageDeflate: false })
  let id = 0
  const pending = new Map()

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000)
    })

  ws.on("message", (data: Buffer) => {
    const msg = JSON.parse(data.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!.resolve(msg.result ?? msg.error)
      pending.delete(msg.id)
    }
  })

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  await send("Page.enable")
  const nav = await send("Page.navigate", { url: TARGET_URL })
  console.log("navigate:", JSON.stringify(nav).slice(0, 120))
  await new Promise((r) => setTimeout(r, 5000))
  const res = await send("Runtime.evaluate", { expression: "document.title + ' | ' + location.href" })
  console.log("页面:", res?.result?.value)
  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1) })
