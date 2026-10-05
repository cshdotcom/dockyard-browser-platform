// ============================================================
// Chromium 企业策略目录（r27-d）
// 1. 策略目录 CHROMIUM_POLICY_CATALOG：36 项 Linux/Chromium 实际支持的企业
//    托管策略（Managed Preferences JSON 注入），供模板编辑器选择 + 校验。
// 2. validateExtraPolicies：模板 policyJson 入库/编辑前校验（键存在性 + 值类型），
//    未知键/类型不符直接拒绝 —— 杜绝拼错键名导致策略静默失效。
// 3. exitGuardManagedPolicy：防退出档位附加策略（封堵账号/无痕/访客等逃逸路径）。
// 合并顺序（network-policy.buildChromiumManagedPolicy）：
//   模板策略项（extraManagedPolicy）先注入 → 文件/CRX/代理/WebRTC 安全层后注入
//   → 安全关键策略（URLBlocklist/ProxyMode/ExtensionSettings 等）永不被模板覆盖。
// ============================================================

export type PolicyValueType = "boolean" | "enum" | "string" | "list" | "number"

export interface ChromiumPolicyItem {
  key: string // Managed Preferences 键名（如 IncognitoModeAvailability）
  name: string // 中文名
  category: string // 目录分类
  description: string
  valueType: PolicyValueType
  options?: Array<{ value: number | string; label: string }> // enum 选项
  example?: string // string/list 示例值
  securityNote?: boolean // true=与安全相关，模板覆盖提示
}

export const CHROMIUM_POLICY_CATALOG: ChromiumPolicyItem[] = [
  // —— 隐私与遥测 ——
  { key: "MetricsReportingEnabled", name: "使用统计与崩溃报告", category: "隐私与遥测", description: "false=关闭 Chromium 使用统计与崩溃数据上报", valueType: "boolean", example: "false" },
  { key: "SafeBrowsingProtectionLevel", name: "安全浏览防护级别", category: "隐私与遥测", description: "0=关 / 1=标准 / 2=增强（拦截危险下载）", valueType: "enum", options: [{ value: 0, label: "关闭" }, { value: 1, label: "标准" }, { value: 2, label: "增强" }] },
  { key: "SafeBrowsingExtendedReportingEnabled", name: "安全浏览扩展报告", category: "隐私与遥测", description: "false=不向 Google 回传可疑页面细节", valueType: "boolean" },
  { key: "SearchSuggestEnabled", name: "搜索建议", category: "隐私与遥测", description: "false=地址栏输入不外发搜索建议请求", valueType: "boolean" },
  { key: "SpellCheckServiceEnabled", name: "拼写检查服务", category: "隐私与遥测", description: "false=禁用联网拼写检查（输入内容不外发）", valueType: "boolean" },
  { key: "UrlKeyedAnonymizedDataCollectionEnabled", name: "匿名化数据采集", category: "隐私与遥测", description: "false=关闭 URL 键控匿名数据采集", valueType: "boolean" },
  // —— 账户与同步 ——
  { key: "BrowserSignin", name: "浏览器登录", category: "账户与同步", description: "0=禁用登录入口（沙箱内不允许登录个人 Google 账号）", valueType: "enum", options: [{ value: 0, label: "禁用" }, { value: 1, label: "允许" }, { value: 2, label: "强制" }] },
  { key: "SyncDisabled", name: "账号同步", category: "账户与同步", description: "true=彻底禁用同步（书签/密码/历史不外传）", valueType: "boolean", example: "true" },
  { key: "BrowserGuestModeEnabled", name: "访客模式", category: "账户与同步", description: "false=禁用访客模式（防未审计环境逃逸）", valueType: "boolean" },
  { key: "BrowserAddProfileEnabled", name: "添加配置文件", category: "账户与同步", description: "false=隐藏「添加配置文件」入口", valueType: "boolean" },
  { key: "IncognitoModeAvailability", name: "无痕模式", category: "账户与同步", description: "1=禁用无痕（全部行为均留痕受审计）", valueType: "enum", options: [{ value: 0, label: "可用" }, { value: 1, label: "禁用" }, { value: 2, label: "强制" }] },
  { key: "PasswordManagerEnabled", name: "密码管理器", category: "账户与同步", description: "false=禁用保存密码（凭据不落沙箱）", valueType: "boolean" },
  { key: "PasswordSharingEnabled", name: "密码共享", category: "账户与同步", description: "false=禁用密码导出/共享", valueType: "boolean" },
  { key: "AutofillAddressEnabled", name: "地址自动填充", category: "账户与同步", description: "false=禁用表单地址自动填充", valueType: "boolean" },
  { key: "AutofillCreditCardEnabled", name: "信用卡自动填充", category: "账户与同步", description: "false=禁用支付卡信息自动填充", valueType: "boolean" },
  // —— 启动与主页 ——
  { key: "RestoreOnStartup", name: "启动页行为", category: "启动与主页", description: "5=恢复上次会话 / 4=打开主页 / 3=打开指定页列表 / 1=空白页", valueType: "enum", options: [{ value: 5, label: "恢复上次会话" }, { value: 4, label: "打开主页" }, { value: 3, label: "打开指定 URL 列表" }, { value: 1, label: "空白页" }], example: "5" },
  { key: "RestoreOnStartupURLs", name: "启动页 URL 列表", category: "启动与主页", description: "启动时打开的 URL 列表（配合 RestoreOnStartup=3）", valueType: "list", example: "[\"https://example.com\"]" },
  { key: "HomepageLocation", name: "主页地址", category: "启动与主页", description: "主页按钮指向的 URL", valueType: "string", example: "https://example.com" },
  { key: "HomepageIsNewTabPage", name: "主页为新标签页", category: "启动与主页", description: "true=主页即新标签页", valueType: "boolean" },
  { key: "ShowHomeButton", name: "显示主页按钮", category: "启动与主页", description: "true=工具栏显示主页按钮", valueType: "boolean" },
  { key: "NewTabPageLocation", name: "新标签页地址", category: "启动与主页", description: "自定义新标签页 URL（留空=默认）", valueType: "string" },
  // —— 浏览体验 ——
  { key: "BookmarkBarEnabled", name: "书签栏", category: "浏览体验", description: "true=常显书签栏 / false=隐藏", valueType: "boolean" },
  { key: "DefaultSearchProviderEnabled", name: "默认搜索引擎开关", category: "浏览体验", description: "false=禁用搜索框直接搜索（需显式访问站点）", valueType: "boolean" },
  { key: "DefaultSearchProviderName", name: "默认搜索引擎名称", category: "浏览体验", description: "自定义搜索引擎显示名", valueType: "string", example: "Bing" },
  { key: "DefaultSearchProviderSearchURL", name: "默认搜索 URL", category: "浏览体验", description: "搜索模板 URL（{searchTerms} 占位）", valueType: "string", example: "https://www.bing.com/search?q={searchTerms}" },
  // —— r38：媒体捕获企业控制（与硬件透传 17 项联动：企业策略层硬门禁） ——
  { key: "VideoCaptureAllowed", name: "视频捕获（摄像头）总闸", category: "媒体捕获与安全", description: "false=企业层全面禁止摄像头（与硬件策略 camera 联动双闸）", valueType: "boolean", securityNote: true },
  { key: "AudioCaptureAllowed", name: "音频捕获（麦克风）总闸", category: "媒体捕获与安全", description: "false=企业层全面禁止麦克风（与硬件策略 microphone 联动双闸）", valueType: "boolean", securityNote: true },
  { key: "ScreenCaptureAllowed", name: "屏幕捕获总闸", category: "媒体捕获与安全", description: "false=禁止 getDisplayMedia 屏幕捕获（桌面信息防泄漏）", valueType: "boolean", securityNote: true },
  { key: "VideoCaptureAllowedUrls", name: "摄像头免询问站点", category: "媒体捕获与安全", description: "无需提示即可使用摄像头的站点列表（谨慎授予）", valueType: "list", example: "[\"https://meet.example.com\"]" },
  { key: "AudioCaptureAllowedUrls", name: "麦克风免询问站点", category: "媒体捕获与安全", description: "无需提示即可使用麦克风的站点列表（谨慎授予）", valueType: "list", example: "[\"https://meet.example.com\"]" },
  // —— r35：搜索引擎完整套件 + DNS 企业控制 ——
  { key: "DefaultSearchProviderKeyword", name: "搜索引擎快捷关键字", category: "浏览体验", description: "地址栏快捷搜索关键字（如 bg）", valueType: "string", example: "bg" },
  { key: "DefaultSearchProviderSuggestURL", name: "搜索建议 URL", category: "浏览体验", description: "搜索建议模板 URL（{searchTerms} 占位）", valueType: "string", example: "https://www.bing.com/osjson.aspx?query={searchTerms}" },
  { key: "DefaultSearchProviderIconURL", name: "搜索引擎图标 URL", category: "浏览体验", description: "搜索引擎图标地址", valueType: "string", example: "https://www.bing.com/favicon.ico" },
  { key: "DefaultSearchProviderEncodings", name: "搜索引擎编码", category: "浏览体验", description: "查询编码列表（通常 UTF-8）", valueType: "list", example: "[\"UTF-8\"]" },
  { key: "DefaultSearchProviderAlternateURLs", name: "搜索备用 URL", category: "浏览体验", description: "备用搜索模板列表", valueType: "list" },
  { key: "DefaultSearchProviderSearchURLPostParams", name: "搜索 POST 参数", category: "浏览体验", description: "POST 形式搜索参数模板", valueType: "string" },
  { key: "SearchEnginesLockDownEnabled", name: "锁定搜索引擎配置", category: "浏览体验", description: "true=用户不可增删改搜索引擎（企业强制）", valueType: "boolean", example: "true" },
  { key: "DnsOverHttpsMode", name: "DNS over HTTPS 模式", category: "浏览体验", description: "off=禁用 / automatic=失败回退 / secure=强制 DoH（安全位置未授予时勿开 secure）", valueType: "enum", options: [{ value: "off", label: "禁用 DoH" }, { value: "automatic", label: "自动（失败回退）" }, { value: "secure", label: "强制 DoH" }] },
  { key: "DnsOverHttpsTemplates", name: "DoH 模板列表", category: "浏览体验", description: "指定 DoH 服务器模板 URL 列表", valueType: "list", example: "[\"https://dns.example/dns-query\"]" },
  { key: "EditBookmarksEnabled", name: "书签编辑", category: "浏览体验", description: "false=禁止增删改书签", valueType: "boolean" },
  { key: "DefaultBrowserSettingEnabled", name: "默认浏览器检查", category: "浏览体验", description: "false=不提示设为默认浏览器", valueType: "boolean" },
  { key: "PromptForDownloadLocation", name: "下载前询问位置", category: "浏览体验", description: "true=每次下载询问保存位置", valueType: "boolean" },
  // —— 下载与打印 ——
  { key: "DownloadRestrictions", name: "下载限制", category: "下载与打印", description: "0=不限 / 1=阻止危险 / 2=阻止危险与恶意 / 3=阻止全部下载", valueType: "enum", options: [{ value: 0, label: "不限" }, { value: 1, label: "阻止危险下载" }, { value: 2, label: "阻止危险与恶意" }, { value: 3, label: "阻止全部下载" }] },
  { key: "DownloadDirectory", name: "下载目录", category: "下载与打印", description: "强制下载落点（沙箱内建议默认 /home/browser/downloads）", valueType: "string", example: "/home/browser/downloads" },
  { key: "PrintingEnabled", name: "打印功能", category: "下载与打印", description: "false=彻底禁用打印（防纸质泄漏）", valueType: "boolean" },
  { key: "PrintHeaderFooterEnabled", name: "打印页眉页脚", category: "下载与打印", description: "false=打印不带 URL 页眉（防地址泄漏）", valueType: "boolean" },
  { key: "AllowFileSelectionDialogs", name: "文件选择对话框", category: "下载与打印", description: "false=禁止网页弹出文件选择框（上传管控）", valueType: "boolean" },
  // —— 开发者与调试 ——
  { key: "DeveloperToolsAvailability", name: "开发者工具", category: "开发者与调试", description: "2=禁用 DevTools（F12/右键检查全关）/ 1=允许 / 3=强制允许", valueType: "enum", options: [{ value: 2, label: "禁用" }, { value: 1, label: "允许" }, { value: 3, label: "强制允许" }], example: "2" },
  { key: "ComponentUpdatesEnabled", name: "组件更新", category: "开发者与调试", description: "false=禁用后台组件热更新（保持环境稳定可复现）", valueType: "boolean" },
  // —— 扩展防护 ——
  { key: "ExtensionAllowedTypes", name: "允许的扩展类型", category: "扩展防护", description: "限定可安装扩展类型白名单（配合 CRX 管控）", valueType: "list", example: "[\"extension\",\"theme\"]" },
  { key: "ManagedBookmarks", name: "托管书签", category: "扩展防护", description: "企业统一推送的只读书签（用户不可删除）", valueType: "list", example: "[{\"name\":\"内部门户\",\"url\":\"https://intra.example.com\"}]" },
  // —— r38：企业安全硬策略（TLS 下限 / 证书自动选择 / 文件系统访问） ——
  { key: "SSLVersionMin", name: "TLS 最低版本", category: "媒体捕获与安全", description: "tls1=1.0（不推荐）/ tls1.1 / tls1.2 —— 企业 TLS 地板（防降级攻击）", valueType: "string", example: "tls1.2", securityNote: true },
  { key: "AutoSelectCertificateForUrls", name: "自动选择客户端证书站点", category: "媒体捕获与安全", description: "匹配的站点免弹窗自动选择客户端证书（列表项须为 URL 模式）", valueType: "list", example: "[\"https://cert.example.com/*\"]", securityNote: true },
  { key: "FileSystemWriteBlockedForUrls", name: "文件系统写入封禁站点", category: "媒体捕获与安全", description: "封禁 File System Access API 写入的站点（数据落地面收敛）", valueType: "list", example: "[\"https://untrusted.example.com\"]", securityNote: true },
]

export const CHROMIUM_POLICY_CATEGORIES = [...new Set(CHROMIUM_POLICY_CATALOG.map((p) => p.category))]

// 安全关键键（平台安全层持有，模板注入无效 → 校验直接拒绝，避免误配）
// 注：DownloadRestrictions / AllowFileSelectionDialogs 在文件策略命中特定值时由
// 文件层覆写（文件层晚于模板层注入 = 安全层优先语义保持）
const SECURITY_OWNED_KEYS = new Set([
  "URLBlocklist", "URLAllowlist", "ProxyMode", "ProxyServer", "ProxyBypassList",
  "ExtensionInstallForcelist", "ExtensionInstallBlocklist", "ExtensionSettings",
  "WebRtcIPHandling", "AllowWebRtcUdpPorts",
])

// ---- 校验：模板 policyJson（键存在 + 类型匹配 + 安全键拒绝）----
export function validateExtraPolicies(json: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const byKey = new Map(CHROMIUM_POLICY_CATALOG.map((p) => [p.key, p]))
  for (const [key, value] of Object.entries(json || {})) {
    if (SECURITY_OWNED_KEYS.has(key)) {
      errors.push(`${key} 属于平台安全层托管（网络/代理/CRX），不允许模板覆盖`)
      continue
    }
    const item = byKey.get(key)
    if (!item) {
      errors.push(`未知策略键：${key}（不在 Chromium 企业策略目录内）`)
      continue
    }
    const t = typeof value
    if (item.valueType === "boolean" && t !== "boolean") errors.push(`${key} 需要 boolean 值`)
    if (item.valueType === "number" && (item.options?.length ? t !== "number" : t !== "number")) errors.push(`${key} 需要 number 值`)
    if (item.valueType === "string" && t !== "string") errors.push(`${key} 需要 string 值`)
    if (item.valueType === "list" && !Array.isArray(value)) errors.push(`${key} 需要 array 值`)
    if (item.valueType === "enum" && item.options && t === "number" && !item.options.some((o) => o.value === value)) {
      errors.push(`${key} 的值 ${value} 不在允许选项内（${item.options.map((o) => o.value).join("/")}）`)
    }
  }
  return { ok: errors.length === 0, errors }
}

// ---- 防退出档位 → 附加托管策略（封堵账号/无痕/访客/加用户等逃逸路径）----
// normal 档不注入（保持历史行为零变更）；fullscreen/kiosk 档注入。
export function exitGuardManagedPolicy(guard?: string): Record<string, unknown> {
  const g = guard || "normal"
  if (g !== "fullscreen" && g !== "kiosk") return {}
  return {
    BrowserSignin: 0, // 禁登录（防通过账号体系同步/逃逸）
    SyncDisabled: true,
    BrowserGuestModeEnabled: false, // 禁访客
    BrowserAddProfileEnabled: false, // 禁加配置文件
    IncognitoModeAvailability: 1, // 禁无痕（全部行为留痕，配合录像审计）
  }
}
