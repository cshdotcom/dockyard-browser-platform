// 环境变量集中管理：敏感信息只存环境变量，绝不入库、绝不进前端
export const ENV = {
  get authSecret() {
    return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dockyard-dev-secret-change-me"
  },
  get encryptionKey() {
    return process.env.ENCRYPTION_KEY || "dockyard-dev-encryption-key-32byte!!" // 32 bytes
  },
  get cronSecret() {
    return process.env.CRON_SECRET || "dockyard-cron-secret"
  },
  get dockerApiUrl() {
    return process.env.DOCKER_API_URL || "" // 为空时进入本地模拟模式
  },
  get dockerApiTimeout() {
    return Number(process.env.DOCKER_API_TIMEOUT || 10000)
  },
  get novncPoolUrl() {
    return process.env.NOVNC_POOL_URL || ""
  },
  // ---- 外部浏览器分离部署（r14：填写则优先外部，未填默认单容器内嵌）----
  get externalBrowserUrl() {
    return (process.env.EXTERNAL_BROWSER_URL || "").trim()
  },
  get externalBrowserCdpPort() {
    return Number(process.env.EXTERNAL_BROWSER_CDP_PORT || 9222)
  },
  get externalBrowserVncPort() {
    return Number(process.env.EXTERNAL_BROWSER_VNC_PORT || 5900)
  },
  // [22-d] VNC 拨号目标主机可选覆盖（默认从 EXTERNAL_BROWSER_URL 推导 host）：
  // 适用 CDP 与 RFB 分置两台主机的拓扑（如 CDP 走域名、RFB 走内网直连）
  get externalBrowserVncHost() {
    return (process.env.EXTERNAL_BROWSER_VNC_HOST || "").trim()
  },
  get smtpHost() {
    return process.env.SMTP_HOST || ""
  },
  get smtpPort() {
    return Number(process.env.SMTP_PORT || 587)
  },
  get smtpUser() {
    return process.env.SMTP_USER || ""
  },
  get smtpPass() {
    return process.env.SMTP_PASS || ""
  },
  get smtpFrom() {
    return process.env.SMTP_FROM || "Dockyard <noreply@dockyard.local>"
  },
  get storageMode() {
    return (process.env.STORAGE_MODE || "local") as "local" | "s3"
  },
  get storageLocalPath() {
    return process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage"
  },
  get cdpServicePort() {
    return Number(process.env.CDP_SERVICE_PORT || 9222) // Docker 镜像内 CDP 服务后台端口（可用环境变量改变）
  },
  get appPort() {
    return Number(process.env.PORT || 3000)
  },
  // ---- HelmPort VNC 网关桥 ----
  get vncBridgeSecret() {
    // 与 mini-services/vnc-bridge 共享的 HMAC 签名密钥（生产由 start.sh 随机生成注入两侧）
    return process.env.VNC_BRIDGE_SECRET || "dockyard-dev-vnc-secret"
  },
  get vncBridgePort() {
    return Number(process.env.VNC_BRIDGE_PORT || 3005)
  },
  get vncBridgePublic() {
    // gateway: 经平台统一域名反代（?XTransformPort=桥端口） | port: 同主机独立端口直连 | url: 自定义基地址
    return (process.env.VNC_BRIDGE_PUBLIC || "gateway") as "gateway" | "port" | "url"
  },
  get vncBridgeUrl() {
    return process.env.VNC_BRIDGE_URL || ""
  },
  get browserImage() {
    return process.env.BROWSER_IMAGE || "ghcr.io/cshdotcom/dockyard-browser:latest" // 自托管硬隔离浏览器镜像（可选外部形态）
  },
  get browserVncPort() {
    return Number(process.env.BROWSER_VNC_PORT || 5900)
  },
  // r36：浏览器容器 CDP 端口（镜像 supervisor 固定 9222；此处保持同值默认，
  // 自定义构建镜像时可改。docker 模式 cdpUrl 推导与就绪探测均使用该端口）
  get browserCdpPort() {
    return Number(process.env.BROWSER_CDP_PORT || 9222)
  },
  // ---- 单容器全内置（r13：默认形态，零外部服务）----
  get browserRuntime() {
    // auto（默认）：容器内浏览器组件齐备 → 单容器内嵌沙箱；否则按外部配置降级
    return (process.env.BROWSER_RUNTIME || "auto").toLowerCase() // auto | embedded | docker | pool
  },
  get embeddedBrowserBin() {
    return process.env.EMBEDDED_BROWSER_BIN || "" // 开发/特殊环境手动指定 chromium 二进制
  },
  // ---- 公开访问基地址（内网穿透/反代/域名部署）----
  // 优先级：PUBLIC_BASE_URL > APP_PUBLIC_URL > AUTH_PUBLIC_URL > AUTH_URL > NEXTAUTH_URL
  // 设置后：NextAuth 回调/重定向、CDP 公网网关端点展示、HelmPort 桥地址拼接均使用该域名；
  // 未设置时自动使用请求 Host（网关同源转发，需反代正确传递 Host 头）。
  get publicBaseUrl() {
    const v =
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_PUBLIC_URL ||
      process.env.AUTH_PUBLIC_URL ||
      process.env.AUTH_URL ||
      process.env.NEXTAUTH_URL ||
      ""
    return v.replace(/\/+$/, "")
  },
  // ---- r28 节点公网展示地址（修"创建节点显示 localhost"问题）----
  // 用途：浏览器节点/Worker 节点创建表单的公网地址推荐与连接信息展示。
  // 优先级：NODE_PUBLIC_URL（专用于节点）> WORKER_PUBLIC_URL > publicBaseUrl。
  // 为空时表单提示"内网地址仅平台同机/同网可用"，不阻塞创建。
  get nodePublicUrl() {
    const v = process.env.NODE_PUBLIC_URL || process.env.WORKER_PUBLIC_URL || ""
    return v.replace(/\/+$/, "")
  },
}

// ---- r28 判断地址是否私网/环回（localhost / 127.* / 10.* / 192.168.* / 172.16-31.* / ::1）----
// 节点表单据此显示警告：该地址仅供平台同机/内网拨号，外部工具无法直连。
export function isPrivateAddress(url: string): boolean {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`)
    const h = u.hostname.toLowerCase()
    if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return true
    if (/^127\./.test(h)) return true
    if (/^10\./.test(h)) return true
    if (/^192\.168\./.test(h)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    if (/^169\.254\./.test(h)) return true
    if (h === "browser-internal") return true
    return false
  } catch {
    return false
  }
}

// 外部服务是否可用（不可用时适配器自动降级为模拟模式，业务链路仍完整可跑）
export const externalAvailable = {
  get docker() { return !!ENV.dockerApiUrl },
  get novnc() { return !!ENV.novncPoolUrl },
  get smtp() { return !!ENV.smtpHost },
  // 外部浏览器分离部署形态（EXTERNAL_BROWSER_URL 填写即启用）——自研会话引擎唯一外部形态
  get external() { return !!ENV.externalBrowserUrl },
  // browser 为语义别名（cdp-control 等调用方使用；等价 external）
  get browser() { return !!ENV.externalBrowserUrl },
}

// ---- [22-d] 跨域请求源白名单（逗号分隔；与 proxy.ts / /api/me/cross-domain 共用）----
// CORS_ALLOWED_ORIGINS（新名称）；兼容旧名称 CORS_ORIGINS。"*" 表示全部允许（不带凭证）
export const corsAllowedOrigins: string[] = (process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
