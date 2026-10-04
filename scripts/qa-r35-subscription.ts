// r35 订阅解析器单元验证（Node 直跑，不依赖 dev server）
import { parseSubscriptionContent, parseShareUri, assertPublicSubscriptionUrl } from "../src/lib/subscription-parser"

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? "") }
}

// ---- ① vmess://（base64 JSON）----
const vmessObj = { v: "2", ps: "香港-01", add: "hk.example.com", port: "443", id: "b831381d-6324-4d53-ad4f-8cda48b30811", aid: "0", scy: "auto", net: "ws", host: "cdn.example.com", path: "/ws", tls: "tls", sni: "hk.example.com" }
const vmessUri = "vmess://" + Buffer.from(JSON.stringify(vmessObj)).toString("base64")

// ---- ② vless://（含 reality）----
const vlessUri = "vless://a2c3d4e5-f6a7-8901-b234-c56789abcdef@1.2.3.4:8443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=pubkey123&sid=abcd&type=tcp&flow=xtls-rprx-vision#日本-02"

// ---- ③ ss:// ----
const ssUri = "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQxMjM@5.6.7.8:8388#美国-01"

// ---- ④ trojan:// ----
const trojanUri = "trojan://pass123@9.8.7.6:443?security=tls&sni=trojan.example.com#新加坡-01"

console.log("== 单条 URI 解析 ==")
const used = new Set<string>()
const vm = parseShareUri(vmessUri, used)
check("vmess 解析出 vmess 节点", vm?.outbound.type === "vmess")
check("vmess server/port", vm?.outbound.server === "hk.example.com" && vm?.outbound.serverPort === 443)
check("vmess userId", vm?.outbound.userId === "b831381d-6324-4d53-ad4f-8cda48b30811")
check("vmess ws transport", vm?.outbound.transport?.type === "ws" && vm?.outbound.transport?.path === "/ws")
check("vmess tls", vm?.outbound.tls?.enabled === true)
check("vmess 名称", vm?.name === "香港-01")

const vl = parseShareUri(vlessUri, used)
check("vless 解析", vl?.outbound.type === "vless" && vl?.outbound.uuid === "a2c3d4e5-f6a7-8901-b234-c56789abcdef")
check("vless reality", vl?.outbound.tls?.reality?.enabled === true && vl?.outbound.tls?.reality?.publicKey === "pubkey123")
check("vless flow", vl?.outbound.flow === "xtls-rprx-vision")

const ss = parseShareUri(ssUri, used)
check("ss 解析 shadowsocks", ss?.outbound.type === "shadowsocks")
check("ss method/password", ss?.outbound.method === "aes-256-gcm" && ss?.outbound.password === "password123")

const tj = parseShareUri(trojanUri, used)
check("trojan 解析", tj?.outbound.type === "trojan" && tj?.outbound.password === "pass123" && tj?.outbound.tls?.enabled === true)

// 坏行不崩溃
check("坏 URI 返回 null", parseShareUri("vmess://!!!not-base64!!!", used) === null)
check("空行返回 null", parseShareUri("", used) === null)

console.log("== 订阅正文解析 ==")
// base64 整体订阅
const subBody = [vmessUri, vlessUri, ssUri, trojanUri, "://bad line"].join("\n")
const b64Sub = Buffer.from(subBody).toString("base64")
const r1 = parseSubscriptionContent(b64Sub)
check("base64 订阅识别", r1.format === "base64-uri-list")
check("base64 订阅 4 节点", r1.nodes.length === 4, r1.nodes.length)
check("base64 订阅坏行计数", r1.failed === 1)

// 明文列表
const r2 = parseSubscriptionContent(subBody)
check("明文列表识别", r2.format === "uri-list" && r2.nodes.length === 4)

// Clash YAML
const clashYaml = `proxies:
  - {name: "HK-yaml", type: vmess, server: yaml-hk.com, port: 443, uuid: uuid-yaml-1, cipher: auto, network: ws, ws-opts: {path: /y}}
  - {name: "US-yaml", type: trojan, server: yaml-us.com, port: 8443, password: tpass}
  - {name: "JP-yaml", type: ss, server: yaml-jp.com, port: 8388, cipher: aes-256-gcm, password: sspass}
proxy-groups: []
`
const r3 = parseSubscriptionContent(clashYaml)
check("Clash YAML 识别", r3.format === "clash-yaml")
check("Clash YAML 3 节点", r3.nodes.length === 3, r3.nodes.length)
check("Clash vmess 字段", r3.nodes[0]?.outbound.server === "yaml-hk.com" && r3.nodes[0]?.outbound.userId === "uuid-yaml-1")

console.log("== SSRF 防护 ==")
const bad = ["http://127.0.0.1:8080/sub", "http://10.0.0.1/sub", "http://192.168.1.1/sub", "http://172.16.0.1/sub", "http://169.254.169.254/latest/meta-data", "http://localhost/sub", "ftp://example.com/sub"]
for (const u of bad) {
  let threw = false
  try { assertPublicSubscriptionUrl(u) } catch { threw = true }
  check(`拒绝 ${u}`, threw)
}
let ok2 = false
try { assertPublicSubscriptionUrl("https://sub.example.com/api?token=x"); ok2 = true } catch { ok2 = false }
check("放行公网订阅", ok2)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
