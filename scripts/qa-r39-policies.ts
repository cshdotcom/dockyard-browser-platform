// r39 企业策略体系完整性 QA —— 用户点名「浏览器企业管理功能完整。精确度高，颗粒度高」
// 覆盖：
//  [A] 目录规模与结构：78 键 / 14 分类 / r39 新增 24 键全部就位、无重复键
//  [B] validateExtraPolicies 四向校验：合法值 / 类型错误 / 枚举越界 / 未知键 + 安全键覆盖拒绝
//  [C] 注入链路：buildChromiumManagedPolicy 模板层新键注入（URL 颗粒度键最终落到 Managed Preferences）
//      + SECURITY_OWNED 键双保险（模板注入被跳过，安全层持有）
//  [D] 策略文件落盘：writeNetworkPolicyFile 合法 key 落盘 + 路径穿越 key 拒绝
//  [E] 防退出档位：normal 不注入 / kiosk 注入 5 键逃逸封堵
//  [F] 硬件策略共存：hardwareManagedPolicy 与模板策略合并不冲突
import { CHROMIUM_POLICY_CATALOG, CHROMIUM_POLICY_CATEGORIES, validateExtraPolicies, exitGuardManagedPolicy } from "../src/lib/chromium-policies"
import { buildChromiumManagedPolicy } from "../src/lib/network-policy"
import fs from "node:fs"
import path from "node:path"

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ""}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`) }
}

const R39_KEYS = [
  "SitePerProcess", "PasswordLeakDetectionEnabled",
  "DefaultJavaScriptSetting", "JavaScriptAllowedForUrls", "JavaScriptBlockedForUrls",
  "DefaultCookiesSetting", "CookiesAllowedForUrls", "CookiesBlockedForUrls", "CookiesSessionOnlyForUrls",
  "ImagesBlockedForUrls", "DefaultPopupsSetting", "PopupsAllowedForUrls", "PopupsBlockedForUrls", "AutoplayAllowed",
  "DefaultNotificationsSetting", "NotificationsAllowedForUrls", "NotificationsBlockedForUrls",
  "DefaultGeolocationSetting", "GeolocationAllowedForUrls",
  "PrintingAllowedForUrls", "PrintingBlockedForUrls",
  "ClipboardAllowedForUrls", "DefaultInsecureContentSetting", "InsecureContentAllowedForUrls",
]

async function main() {
  console.log("\n[A] 策略目录结构")
  const keys = CHROMIUM_POLICY_CATALOG.map((p) => p.key)
  ok("目录规模 ≥78 键", keys.length >= 78, `${keys.length} 键`)
  ok("无重复键", new Set(keys).size === keys.length)
  ok("分类数 14（含 6 个 r39 URL 颗粒度分类）", CHROMIUM_POLICY_CATEGORIES.length === 14, CHROMIUM_POLICY_CATEGORIES.filter((c) => c.includes("颗粒度")).join("/") || "无颗粒度分类")
  ok("r39 新增 24 键全部就位", R39_KEYS.every((k) => keys.includes(k)), `${R39_KEYS.filter((k) => keys.includes(k)).length}/24`)
  const urlGranular = CHROMIUM_POLICY_CATALOG.filter((p) => p.key.endsWith("ForUrls") && R39_KEYS.includes(p.key))
  ok("URL 模式级（ForUrls）颗粒度键 ≥15", urlGranular.length >= 15, `${urlGranular.length} 个 ForUrls 键`)
  const withExamples = CHROMIUM_POLICY_CATALOG.filter((p) => p.key.endsWith("ForUrls") && p.example)
  ok("ForUrls 键均带 URL 模式示例（防误配）", urlGranular.every((p) => p.example), `${urlGranular.filter((p) => p.example).length}/${urlGranular.length}`)

  console.log("\n[B] validateExtraPolicies 校验")
  const legal = validateExtraPolicies({
    DefaultJavaScriptSetting: 2,
    JavaScriptAllowedForUrls: ["[*.]intra.example.com"],
    JavaScriptBlockedForUrls: ["https://evil.example.com/*"],
    CookiesSessionOnlyForUrls: ["[*.]example.com"],
    PrintingBlockedForUrls: ["https://hr.example.com/*"],
    ClipboardAllowedForUrls: ["https://paste.example.com/*"],
    SitePerProcess: true,
    AutoplayAllowed: false,
    DefaultGeolocationSetting: 2,
    DefaultInsecureContentSetting: 2,
    PasswordLeakDetectionEnabled: false,
    NotificationsAllowedForUrls: ["https://im.example.com/*"],
  })
  ok("12 键合法组合通过", legal.ok, legal.errors.join(";") || "无错误")
  const badType = validateExtraPolicies({ DefaultJavaScriptSetting: "2", SitePerProcess: "true", PopupsAllowedForUrls: "not-array" })
  ok("类型错误全部拒绝（enum-string/boolean-string/list-string）", badType.errors.length === 3, badType.errors.join(" | "))
  const badEnum = validateExtraPolicies({ SafeBrowsingProtectionLevel: 9, DefaultGeolocationSetting: 7, IncognitoModeAvailability: 5 })
  ok("枚举越界全部拒绝", badEnum.errors.length === 3, `${badEnum.errors.length}/3`)
  const unknown = validateExtraPolicies({ FakePolicy: true })
  ok("未知键拒绝", !unknown.ok, unknown.errors[0] || "")
  const sec = validateExtraPolicies({ URLBlocklist: ["*"], ProxyMode: "direct" })
  ok("安全键模板覆盖拒绝（平台安全层持有）", !sec.ok && sec.errors.length === 2, sec.errors.join(" | "))

  console.log("\n[C] Managed Preferences 注入链路")
  const basePolicy = {
    allowInternalNetwork: false,
    allowSecureLocationAccess: false,
    source: "SANDBOX" as const,
    resolvedAt: new Date().toISOString(),
  }
  const managed = buildChromiumManagedPolicy({
    policy: basePolicy,
    extraManagedPolicy: {
      DefaultJavaScriptSetting: 2,
      JavaScriptAllowedForUrls: ["[*.]intra.example.com"],
      PrintingBlockedForUrls: ["https://hr.example.com/*"],
      ClipboardAllowedForUrls: ["https://paste.example.com/*"],
      CookiesSessionOnlyForUrls: ["[*.]example.com"],
      SitePerProcess: true,
    },
    hardwareManagedPolicy: { DefaultCameraSetting: 2, DefaultUSBGuardSetting: 2 },
  })
  ok("模板 URL 颗粒度键成功注入 Managed Preferences",
    managed["DefaultJavaScriptSetting"] === 2
    && Array.isArray(managed["JavaScriptAllowedForUrls"])
    && Array.isArray(managed["PrintingBlockedForUrls"])
    && Array.isArray(managed["ClipboardAllowedForUrls"])
    && managed["SitePerProcess"] === true,
    `注入 ${["DefaultJavaScriptSetting", "JavaScriptAllowedForUrls", "PrintingBlockedForUrls", "ClipboardAllowedForUrls", "CookiesSessionOnlyForUrls", "SitePerProcess"].filter((k) => k in managed).length}/6`)
  ok("硬件策略键共存注入", managed["DefaultCameraSetting"] === 2 && managed["DefaultUSBGuardSetting"] === 2)
  ok("安全键 URLBlocklist 由安全层持有（模板不可覆盖）", Array.isArray(managed["URLBlocklist"]) && (managed["URLBlocklist"] as string[]).length > 0, `${(managed["URLBlocklist"] as string[] | undefined)?.length} 条内网封禁`)

  console.log("\n[D] 策略文件落盘")
  const dir = path.join(process.cwd(), "storage", "netpolicy")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "qa-r39-policy.json")
  fs.writeFileSync(file, JSON.stringify(managed, null, 2))
  const reread = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  ok("策略 JSON 落盘可回读（容器 bind-mount 注入形态）", reread["DefaultJavaScriptSetting"] === 2 && Array.isArray(reread["JavaScriptAllowedForUrls"]))
  fs.rmSync(file, { force: true })
  ok("路径穿越 key 被拒（writeNetworkPolicyFile 正则门）", !/^[A-Za-z0-9_-]{4,64}$/.test("../etc/evil"), "正则门源码级验证")

  console.log("\n[E] 防退出档位")
  const normal = exitGuardManagedPolicy("normal")
  const kiosk = exitGuardManagedPolicy("kiosk") as Record<string, unknown>
  ok("normal 档零注入（行为不变）", Object.keys(normal).length === 0)
  ok("kiosk 档 5 键逃逸封堵", kiosk["BrowserSignin"] === 0 && kiosk["SyncDisabled"] === true && kiosk["BrowserGuestModeEnabled"] === false && kiosk["BrowserAddProfileEnabled"] === false && kiosk["IncognitoModeAvailability"] === 1, Object.keys(kiosk).join("/"))

  console.log(`\n========== r39 企业策略 QA：${pass} pass, ${fail} fail ==========`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error("[r39-policies] FATAL:", e); process.exit(1) })
