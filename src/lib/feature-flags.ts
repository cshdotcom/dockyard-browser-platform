// ============================================================
// 功能开关注册表（r27-f）
// 企业级特性治理：把散落在 system_config 的功能型开关收敛为
// 统一目录（分组/说明/默认值/生效语义），管理后台「功能开关」页
// 一屏总览 + 一键切换（复用 setConfigAction：版本快照 + 审计 + 缓存刷新）。
// 约束：
//   · 仅 boolean 型功能开关入册（数值/字符串参数仍归「系统配置」页）
//   · effect 描述生效时机（立即 / 下次会话 / 下次构建）
//   · FEATURE_FLAG_PAGE_ROLES 控制页面可见角色（ADMIN+ 查看仅超管可写）
// ============================================================

export interface FeatureFlagDef {
  key: string // system_config 键（setConfigAction 写入）
  name: string
  category: string
  description: string
  effect: "immediate" | "next-session" | "next-build"
  default: boolean
}

export const FEATURE_FLAGS: FeatureFlagDef[] = [
  // —— 会话与 VNC ——
  { key: "vnc.recordingEnabled", name: "VNC 会话录像", category: "会话与 VNC", description: "开启后命中策略链的沙箱自动开录（四级策略：沙箱>用户>组>全局默认）", effect: "next-session", default: false },
  { key: "vnc.recordingUserVisible", name: "录像用户端可见", category: "会话与 VNC", description: "用户空间「我的录像」页可见本人录像（关闭=仅管理后台可见）", effect: "immediate", default: true },
  { key: "vnc.recordingManualStop", name: "用户手动停录", category: "会话与 VNC", description: "允许用户在会话中自行结束录像（默认仅管理员可操作）", effect: "next-session", default: false },
  { key: "workspace.clipboardVncSync", name: "VNC 剪贴板透传", category: "会话与 VNC", description: "X 剪贴板向 VNC 端透传（关闭=沙箱内复制内容不出屏）", effect: "next-session", default: true },
  { key: "workspace.clipboardGlobal", name: "NoVNC 双向剪贴板", category: "会话与 VNC", description: "NoVNC 通道双向剪贴板全局开关", effect: "immediate", default: true },
  { key: "workspace.vncWatermark", name: "VNC 水印", category: "会话与 VNC", description: "VNC 连接水印（溯源威慑）", effect: "immediate", default: true },
  { key: "workspace.vncAutoQuality", name: "VNC 自适应画质", category: "会话与 VNC", description: "按网络状况自动调节帧率/清晰度", effect: "immediate", default: true },
  { key: "workspace.prewarmEnabled", name: "会话预热池", category: "会话与 VNC", description: "预建沙箱进程树，冷启动提速", effect: "next-build", default: false },
  // —— 安全与合规 ——
  { key: "security.allowRegister", name: "开放注册", category: "安全与合规", description: "是否允许新用户自助注册", effect: "immediate", default: true },
  { key: "security.requireEmailActivation", name: "注册邮箱激活", category: "安全与合规", description: "新注册账号须邮箱激活后方可登录", effect: "immediate", default: false },
  { key: "security.globalForce2fa", name: "全局强制 2FA", category: "安全与合规", description: "全部用户必须开启两步验证", effect: "immediate", default: false },
  { key: "security.ipBanEnabled", name: "IP 自动封禁", category: "安全与合规", description: "登录/API-Key 连续失败达阈值自动封禁来源 IP", effect: "immediate", default: true },
  { key: "security.remoteLoginAlert", name: "异地登录告警", category: "安全与合规", description: "新 IP 登录邮件提醒", effect: "immediate", default: true },
  { key: "security.passwordBanWeakDict", name: "弱密码字典拦截", category: "安全与合规", description: "注册/改密时拦截常见弱密码", effect: "immediate", default: true },
  // —— 运维与告警 ——
  { key: "alert.hostEnabled", name: "宿主机水位预警", category: "运维与告警", description: "CPU/内存/磁盘超阈值告警", effect: "immediate", default: true },
  { key: "alert.emailEnabled", name: "告警邮件通道", category: "运维与告警", description: "达到级别告警同步邮件通知", effect: "immediate", default: false },
  { key: "alert.criticalWebhookOnly", name: "仅严重走 Webhook", category: "运维与告警", description: "Webhook 只推送 CRITICAL 级告警", effect: "immediate", default: false },
  { key: "alert.sessionQuotaEnabled", name: "会话配额预警", category: "运维与告警", description: "全局会话水位触线告警", effect: "immediate", default: true },
  { key: "alert.configDriftEnabled", name: "配置漂移预警", category: "运维与告警", description: "内存缓存与库内配置漂移检测告警", effect: "immediate", default: true },
  { key: "alert.taskFailEnabled", name: "任务失败预警", category: "运维与告警", description: "定时任务连续失败告警", effect: "immediate", default: true },
  // —— 备份与存储 ——
  { key: "backup.enabled", name: "定时备份", category: "备份与存储", description: "按计划自动备份数据库", effect: "immediate", default: true },
  { key: "backup.encrypt", name: "备份加密", category: "备份与存储", description: "备份归档 AES 加密", effect: "immediate", default: false },
  { key: "storage.virusScan", name: "文件病毒扫描", category: "备份与存储", description: "上传文件病毒扫描开关", effect: "immediate", default: false },
  { key: "storage.backupOnDelete", name: "删除前备份", category: "备份与存储", description: "删除文件时自动留存备份副本", effect: "immediate", default: false },
]

export const FEATURE_FLAG_CATEGORIES = [...new Set(FEATURE_FLAGS.map((f) => f.category))]

export const EFFECT_LABEL: Record<FeatureFlagDef["effect"], string> = {
  immediate: "立即生效",
  "next-session": "下次会话生效",
  "next-build": "下次启动生效",
}
