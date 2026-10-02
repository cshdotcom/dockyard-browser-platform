// ============================================================
// 外部浏览器分离部署形态（r14）— EXTERNAL_BROWSER_URL
//
// 语义：浏览器运行时两种部署形态可切换：
//   1. 分离部署：docker/browser 硬隔离浏览器镜像独立运行（同一台或另一台主机），
//      平台经 EXTERNAL_BROWSER_URL 指定其地址 —— 所有会话挂接该自部署浏览器
//   2. 单容器内嵌（默认）：EXTERNAL_BROWSER_URL 未填写时，使用容器内嵌浏览器
//      （Xvfb + Chromium + x11vnc 同容器进程树，零外部依赖）
//
// 地址格式（CDP 基地址；RFB/VNC 端口独立可配）：
//   http://192.168.1.10:9222   → host=192.168.1.10  cdpPort=9222
//   https://browser.lan        → host=browser.lan   cdpPort=9222（默认）
//   192.168.1.10               → host=192.168.1.10  cdpPort=9222（默认）
// 端口覆盖：URL 内嵌端口优先；EXTERNAL_BROWSER_CDP_PORT / EXTERNAL_BROWSER_VNC_PORT
//   可分别指定 CDP 与 RFB 端口（默认 9222 / 5900，与 docker/browser 镜像 EXPOSE 一致）
//
// 生命周期语义：外部浏览器由其自身 supervisor（docker/browser 镜像 PID 1）管理
//   —— 崩溃 1s 内同 Profile 自动拉起；平台侧只做连接与探测，不创建/不销毁其进程。
// ============================================================

import { ENV } from "../env"

export interface ExternalBrowserEndpoint {
  host: string
  cdpPort: number
  vncPort: number
  cdpBase: string // CDP HTTP 基地址（/json/version、/json 列表）
  rfb: { host: string; port: number } // VNC 桥 TCP 拨号目标（[22-d] host 可被 EXTERNAL_BROWSER_VNC_HOST 覆盖，默认从 URL 推导）
  raw: string
}

// 解析 EXTERNAL_BROWSER_URL → 结构化端点（未配置返回 null）
export function externalBrowserEndpoint(): ExternalBrowserEndpoint | null {
  const raw = ENV.externalBrowserUrl
  if (!raw) return null
  // 兼容 http(s)/ws(s) 前缀、host、host:port 三种形态
  const m = raw.match(/^(?:(?:https?|wss?):\/\/)?([^/:?#]+)(?::(\d+))?/i)
  if (!m || !m[1]) return null
  const host = m[1]
  // URL 内嵌端口优先（操作者显式写在地址里）；其次环境变量；最后镜像默认 9222
  const cdpPort = m[2] ? Number(m[2]) : ENV.externalBrowserCdpPort
  const vncPort = ENV.externalBrowserVncPort
  // [22-d] RFB 目标主机：默认与 CDP 同 host；EXTERNAL_BROWSER_VNC_HOST 可覆盖
  //（适用 CDP 与 VNC 分置两台主机的拓扑：CDP 走域名，RFB 走内网直连）
  const rfbHost = ENV.externalBrowserVncHost || host
  const scheme = /^wss?:\/\//i.test(raw) || /^https:\/\//i.test(raw) ? "https" : "http"
  const cdpBase = `${scheme}://${host}:${cdpPort}`
  return { host, cdpPort, vncPort, cdpBase, rfb: { host: rfbHost, port: vncPort }, raw }
}

export interface ExternalBrowserProbe {
  ok: boolean
  browser?: string // 如 "Chrome/128.0.6613.84"
  userAgent?: string
  webSocketDebuggerUrl?: string
  latencyMs?: number
  error?: string
  endpoint?: ExternalBrowserEndpoint
}

// 探测外部浏览器可达性（CDP /json/version 真实握手；不入库、不打日志刷屏）
export async function probeExternalBrowser(timeoutMs = 5000): Promise<ExternalBrowserProbe> {
  const ep = externalBrowserEndpoint()
  if (!ep) return { ok: false, error: "EXTERNAL_BROWSER_URL 未配置" }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${ep.cdpBase}/json/version`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, error: `CDP 探测返回 HTTP ${res.status}`, endpoint: ep }
    const json = (await res.json().catch(() => null)) as
      | { Browser?: string; "User-Agent"?: string; webSocketDebuggerUrl?: string }
      | null
    return {
      ok: true,
      browser: json?.Browser,
      userAgent: json?.["User-Agent"],
      webSocketDebuggerUrl: json?.webSocketDebuggerUrl,
      latencyMs: Date.now() - t0,
      endpoint: ep,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg.includes("abort") ? `连接超时（${timeoutMs}ms）` : msg, endpoint: ep }
  } finally {
    clearTimeout(timer)
  }
}

// 外部浏览器形态的隔离快照（落库展示：安全面板「外部浏览器（分离部署）」）
// 说明：真实隔离规格由外部部署侧决定（docker/browser 镜像默认：非 root/只读根 FS/
// CapDrop=ALL/noexec 下载目录/supervisor 防退出）；平台侧不重复执行，仅如实标注
import type { BrowserHardeningInfo } from "./docker"

export function externalBrowserHardening(
  params: {
    cpuLimit?: number
    memLimitMb?: number
    networkPolicy?: { allowInternalNetwork: boolean; allowSecureLocationAccess: boolean }
    domainPolicy?: { mode: string; blackPatterns: string[]; whitePatterns: string[] } | null
    endpointPolicy?: { blackPatterns: string[]; whitePatterns: string[] } | null
  },
  probe: ExternalBrowserProbe,
): BrowserHardeningInfo {
  const ep = probe.endpoint
  return {
    readOnlyRootfs: true, // docker/browser 镜像默认规格（外部部署时应沿用）
    capDropAll: true,
    noNewPrivileges: true,
    isolatedProfileVolume: true,
    noexecTmpDirs: ["/home/browser/downloads"],
    noexecDownloads: true,
    restartPolicy: "always",
    supervisorLoop: true,
    nonRootUser: "browser",
    pidsLimit: 256,
    memLimitMb: params.memLimitMb ?? 1024,
    cpuLimit: params.cpuLimit ?? 1,
    networkIsolated: false, // 网络隔离由外部部署侧编排（会话网络/ICC 由其部署拓扑决定）
    oomHardKill: true,
    profileDir: null,
    image: `外部浏览器（分离部署 ${ep ? `${ep.host}:${ep.cdpPort}` : ""}）`,
    allowInternalNetwork: params.networkPolicy?.allowInternalNetwork ?? false,
    allowSecureLocationAccess: params.networkPolicy?.allowSecureLocationAccess ?? false,
    domainPolicy: params.domainPolicy
      ? { mode: params.domainPolicy.mode, blackPatterns: params.domainPolicy.blackPatterns, whitePatterns: params.domainPolicy.whitePatterns }
      : undefined,
    endpointPolicy: params.endpointPolicy
      ? { blackPatterns: params.endpointPolicy.blackPatterns, whitePatterns: params.endpointPolicy.whitePatterns }
      : undefined,
    policyManagedChromium: false, // 策略由外部部署侧自管（平台无法注入只读策略文件）
    iccDisabledNetwork: false,
    runtime: "external",
    externalBrowser: {
      endpoint: ep ? `${ep.host}:${ep.cdpPort}` : "",
      vncEndpoint: ep ? `${ep.rfb.host}:${ep.rfb.port}` : "",
      browser: probe.browser || null,
      latencyMs: probe.latencyMs ?? null,
      // 策略提示：外部形态下平台网络/域名/端点策略不强制下发（无法注入），由部署侧 Chromium 托管策略执行
      policyNote: "平台策略不注入：网络/域名/CRX 策略由外部浏览器部署侧管理",
    },
  }
}
