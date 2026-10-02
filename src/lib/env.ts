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
  get steelUrl() {
    return process.env.STEEL_BROWSER_URL || "" // 为空时进入模拟模式
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
}

// 外部服务是否可用（不可用时适配器自动降级为模拟模式，业务链路仍完整可跑）
export const externalAvailable = {
  get docker() { return !!ENV.dockerApiUrl },
  get steel() { return !!ENV.steelUrl },
  get novnc() { return !!ENV.novncPoolUrl },
  get smtp() { return !!ENV.smtpHost },
  // 外部浏览器分离部署形态（EXTERNAL_BROWSER_URL 填写即启用）
  get external() { return !!ENV.externalBrowserUrl },
}
