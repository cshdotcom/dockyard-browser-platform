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
}

// 外部服务是否可用（不可用时适配器自动降级为模拟模式，业务链路仍完整可跑）
export const externalAvailable = {
  get docker() { return !!ENV.dockerApiUrl },
  get steel() { return !!ENV.steelUrl },
  get novnc() { return !!ENV.novncPoolUrl },
  get smtp() { return !!ENV.smtpHost },
}
