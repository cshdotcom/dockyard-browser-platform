// ============================================================
// Chromium 企业策略目录（r27-d 初建 / r39 颗粒度大补强）
// 1. 策略目录 CHROMIUM_POLICY_CATALOG：89 项 Linux/Chromium 实际支持的企业
//    托管策略（Managed Preferences JSON 注入），供模板编辑器选择 + 校验。
//    r39 新增 6 大 URL 级内容颗粒度分类（JS/Cookie/弹窗/通知/位置/打印/
//    剪贴板/混合内容/站点隔离）—— 企业最小权限浏览，精确到站点模式。
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
  { key: "PasswordLeakDetectionEnabled", name: "密码泄漏检测", category: "隐私与遥测", description: "false=关闭密码泄漏检测（输入凭据不回传 Google 对照泄露库；沙箱凭据隔离场景建议关闭）", valueType: "boolean", example: "false" },
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
  { key: "SitePerProcess", name: "站点进程隔离", category: "媒体捕获与安全", description: "true=每站点独立渲染进程（强化隔离，防跨站侧信道与渲染层逃逸，内存开销略增）", valueType: "boolean", example: "true", securityNote: true },

  // —— 内容颗粒度（脚本）【r39：URL 级 JS 管控 —— 企业最小权限浏览】 ——
  { key: "DefaultJavaScriptSetting", name: "JavaScript 默认策略", category: "内容颗粒度（脚本）", description: "1=全站允许 / 2=全站禁用（再以 URL 白名单放行 —— 最小权限）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }] },
  { key: "JavaScriptAllowedForUrls", name: "JS 白名单站点", category: "内容颗粒度（脚本）", description: "允许执行 JS 的站点模式（[*.]host 或 URL 模式 https://example.com/*）", valueType: "list", example: "[\"[*.]intra.example.com\"]" },
  { key: "JavaScriptBlockedForUrls", name: "JS 黑名单站点", category: "内容颗粒度（脚本）", description: "禁止执行 JS 的站点模式（优先于白名单）", valueType: "list", example: "[\"https://evil.example.com/*\"]" },

  // —— 内容颗粒度（Cookie）【r39：URL 级 Cookie 管控 —— 防持久化追踪】 ——
  { key: "DefaultCookiesSetting", name: "Cookie 默认策略", category: "内容颗粒度（Cookie）", description: "1=允许 / 2=阻止（再以 URL 白名单放行）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }] },
  { key: "CookiesAllowedForUrls", name: "Cookie 白名单站点", category: "内容颗粒度（Cookie）", description: "允许写入 Cookie 的站点模式", valueType: "list", example: "[\"[*.]sso.example.com\"]" },
  { key: "CookiesBlockedForUrls", name: "Cookie 黑名单站点", category: "内容颗粒度（Cookie）", description: "禁止 Cookie 的站点模式（优先于白名单）", valueType: "list", example: "[\"https://tracker.example.com/*\"]" },
  { key: "CookiesSessionOnlyForUrls", name: "会话 Cookie 站点", category: "内容颗粒度（Cookie）", description: "匹配站点 Cookie 仅存会话期（关闭浏览器即焚 —— 平衡可用与防追踪）", valueType: "list", example: "[\"[*.]example.com\"]" },

  // —— 内容颗粒度（媒体体验）【r39：图像/弹窗/自动播放管控】 ——
  { key: "ImagesBlockedForUrls", name: "图像封禁站点", category: "内容颗粒度（媒体体验）", description: "禁止加载图像的站点模式（带宽收敛/强制纯文本场景）", valueType: "list", example: "[\"https://heavy.example.com/*\"]" },
  { key: "DefaultPopupsSetting", name: "弹窗默认策略", category: "内容颗粒度（媒体体验）", description: "1=允许 / 2=阻止（默认建议阻止）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }] },
  { key: "PopupsAllowedForUrls", name: "弹窗白名单站点", category: "内容颗粒度（媒体体验）", description: "允许弹窗的站点模式（企业 SSO/办公门户常见需要）", valueType: "list", example: "[\"https://portal.example.com/*\"]" },
  { key: "PopupsBlockedForUrls", name: "弹窗黑名单站点", category: "内容颗粒度（媒体体验）", description: "禁止弹窗的站点模式", valueType: "list", example: "[\"https://ads.example.com/*\"]" },
  { key: "AutoplayAllowed", name: "自动播放总闸", category: "内容颗粒度（媒体体验）", description: "false=禁止页面媒体自动播放（噪音/带宽管控；用户手动点击仍可播）", valueType: "boolean", example: "false" },

  // —— 内容颗粒度（通知与位置）【r39：防骚扰 + 位置泄漏颗粒度】 ——
  { key: "DefaultNotificationsSetting", name: "通知默认策略", category: "内容颗粒度（通知与位置）", description: "1=允许 / 2=阻止 / 3=每次询问（默认建议 2 阻止）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }, { value: 3, label: "询问" }] },
  { key: "NotificationsAllowedForUrls", name: "通知白名单站点", category: "内容颗粒度（通知与位置）", description: "允许 Web 通知的站点模式（内部告警/IM 门户）", valueType: "list", example: "[\"https://im.example.com/*\"]" },
  { key: "NotificationsBlockedForUrls", name: "通知黑名单站点", category: "内容颗粒度（通知与位置）", description: "禁止 Web 通知的站点模式", valueType: "list", example: "[\"https://news.example.com/*\"]" },
  { key: "DefaultGeolocationSetting", name: "地理位置默认策略", category: "内容颗粒度（通知与位置）", description: "1=允许 / 2=阻止 / 3=每次询问（防位置泄漏建议 2）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }, { value: 3, label: "询问" }] },
  { key: "GeolocationAllowedForUrls", name: "地理位置白名单站点", category: "内容颗粒度（通知与位置）", description: "允许地理定位的站点模式（地图类业务放行）", valueType: "list", example: "[\"https://maps.example.com/*\"]" },

  // —— 内容颗粒度（打印）【r39：URL 级打印管控 —— 与远程打印/审计联动】 ——
  { key: "PrintingAllowedForUrls", name: "打印白名单站点", category: "内容颗粒度（打印）", description: "允许打印的站点模式（未匹配则受 PrintingEnabled 总闸控制）", valueType: "list", example: "[\"https://docs.example.com/*\"]" },
  { key: "PrintingBlockedForUrls", name: "打印黑名单站点", category: "内容颗粒度（打印）", description: "禁止打印的站点模式（敏感系统防纸质泄漏，优先于白名单）", valueType: "list", example: "[\"https://hr-payroll.example.com/*\"]" },

  // —— 内容颗粒度（剪贴板与混合内容）【r39：数据外发与降级内容收敛】 ——
  { key: "ClipboardAllowedForUrls", name: "剪贴板读取白名单", category: "内容颗粒度（剪贴板与混合内容）", description: "允许通过剪贴板 API 读取的站点模式（默认全拒 —— 密码/内容防读出）", valueType: "list", example: "[\"https://paste.example.com/*\"]", securityNote: true },
  { key: "DefaultInsecureContentSetting", name: "混合内容默认策略", category: "内容颗粒度（剪贴板与混合内容）", description: "2=阻止 / 3=允许（HTTPS 页内加载 HTTP 资源 —— 建议阻止防中间人注入）", valueType: "enum", options: [{ value: 2, label: "阻止" }, { value: 3, label: "允许" }] },
  { key: "InsecureContentAllowedForUrls", name: "混合内容白名单站点", category: "内容颗粒度（剪贴板与混合内容）", description: "允许加载混合内容的站点模式（遗留内网系统兼容）", valueType: "list", example: "[\"https://legacy.example.com/*\"]" },

  // —— 【r40：DNS 与域名解析控制】——
  { key: "BuiltInDnsClientEnabled", name: "内置 DNS 客户端", category: "DNS 与域名解析控制", description: "true=Chromium 内置异步 DNS 解析（与 DnsOverHttps 联动全托管） / false=回退系统 getaddrinfo（沙箱 hosts 生效）。DNS 行为企业统一管控", valueType: "boolean", example: "true", securityNote: true },
  { key: "DnsOverHttpsMode", name: "DNS over HTTPS 模式", category: "DNS 与域名解析控制", description: "off=禁用 / automatic=失败回退 / secure=强制 DoH（安全位置未授予时勿开 secure）", valueType: "enum", options: [{ value: "off", label: "禁用 DoH" }, { value: "automatic", label: "自动（失败回退）" }, { value: "secure", label: "强制 DoH" }] },
  { key: "DnsOverHttpsTemplates", name: "DoH 模板列表", category: "DNS 与域名解析控制", description: "指定 DoH 服务器模板 URL 列表（企业自建 DoH 指向内部解析器，配合域名黑白名单）", valueType: "list", example: "[\"https://dns.example/dns-query\"]" },
  { key: "SSLErrorOverrideAllowed", name: "SSL 错误继续访问", category: "DNS 与域名解析控制", description: "false=SSL 证书错误页禁用「忽略并继续」按钮（中间人攻击防线；配合 TLS 地板策略）", valueType: "boolean", example: "false", securityNote: true },
  { key: "ForceEphemeralProfiles", name: "临时配置文件", category: "DNS 与域名解析控制", description: "true=会话级临时 Profile（关闭即焚 —— Cookie/缓存/存储零残留；书签/历史不持久化，审计留存平台侧录像）", valueType: "boolean" },

  // —— 【r40：扩展安装与来源强制管控】——
  { key: "ExtensionInstallSources", name: "扩展安装源白名单", category: "扩展防护", description: "允许安装扩展的来源 URL 模式（默认仅 CWS；配合 CRX 强装/黑名单形成三层管控）", valueType: "list", example: "[\"https://clients2.google.com/service/update2/crx*\"]", securityNote: true },
  { key: "ExtensionInstallAllowlist", name: "扩展安装豁免白名单", category: "扩展防护", description: "豁免全局扩展黑名单（ExtensionInstallBlocklist 为 * 时仍可安装的扩展 ID 列表；最小权限放行）", valueType: "list", example: "[\"abcdefghijklmnopqrstuvwxyzabcdefgh\"]", securityNote: true },
  { key: "BlockExternalExtensions", name: "禁外部扩展注入", category: "扩展防护", description: "true=禁止网页/外部程序触发「添加扩展」流程（第三方注入防线 —— 只留企业 CRX 强装通道）", valueType: "boolean", example: "true", securityNote: true },
  { key: "ExtensionInstallBlocklist", name: "扩展安装黑名单", category: "扩展防护", description: "被禁止安装的扩展 ID 列表（[\"*\"]=全禁安装，仅白名单豁免；平台 CRX 管控页持有安全层注入）", valueType: "list", example: "[\"*\"]", securityNote: true },
  { key: "ExtensionInstallForcelist", name: "扩展强制安装", category: "扩展防护", description: "强制安装的扩展列表（[\"<crxId>;<update_url>\"] —— 企业统一推送；平台 CRX 管控页持有安全层注入）", valueType: "list", example: "[\"abcdefghij...;https://update.example/crx\"]", securityNote: true },
  { key: "ExtensionSettings", name: "扩展细粒度设置", category: "扩展防护", description: "每扩展 installation_mode/权限黑名单 JSON（blocked_permissions/host 许可；平台 CRX 管控页持有安全层注入）", valueType: "string", example: "{\"abc\":{\"installation_mode\":\"force_installed\"}}", securityNote: true },

  // —— 【r40：打印企业模板管控 —— 与远程打印机池联动】——
  { key: "PrintHeaderTemplate", name: "打印页眉模板", category: "内容颗粒度（打印）", description: "统一页眉模板（占位符：\$TITLE \$URL \$DATE \$TIME —— 企业水印防伪溯源）", valueType: "string", example: "\$TITLE - 内部资料" },
  { key: "PrintFooterTemplate", name: "打印页脚模板", category: "内容颗粒度（打印）", description: "统一页脚模板（占位符：\$TITLE \$URL \$DATE \$TIME \$PAGE_NUMBER \$TOTAL_PAGES —— 页码水印）", valueType: "string", example: "\$USERNAME · \$DATE · \$PAGE_NUMBER/\$TOTAL_PAGES" },
  { key: "SystemPrintDialogEnabled", name: "系统打印对话框", category: "内容颗粒度（打印）", description: "true=打印预览界面提供「使用系统对话框」入口（false=仅 Chromium 预览管控路径，打印审计更完整）", valueType: "boolean" },
  { key: "PrintPreviewStickySettings", name: "打印设置粘性记忆", category: "内容颗粒度（打印）", description: "true=记住用户上次打印设置（纸张/双面；false=每次回到企业默认）", valueType: "boolean" },

  // —— 【r40：进程与逃逸收口】——
  { key: "TaskManagerEndProcessEnabled", name: "任务管理器结束进程", category: "开发者与调试", description: "false=禁用 Shift+Esc 任务管理器的「结束进程」（防用户杀渲染进程绕过会话审计）", valueType: "boolean", example: "false", securityNote: true },
  { key: "BackgroundModeEnabled", name: "后台运行模式", category: "开发者与调试", description: "false=关闭所有窗口后浏览器不驻留后台（会话生命周期与沙箱回收对齐）", valueType: "boolean" },
  { key: "RestrictSigninToPattern", name: "登录账号限制", category: "账户与同步", description: "限制可登录账号的邮箱模式（*=@corp.example.com —— 账号体系企业收口）", valueType: "string", example: "*@corp.example.com", securityNote: true },

  // —— 【r40：媒体体验与家长控制补全】——
  { key: "DefaultImagesSetting", name: "图像默认策略", category: "内容颗粒度（媒体体验）", description: "1=允许 / 2=阻止（再以 URL 封禁细化 —— 带宽收敛默认策略）", valueType: "enum", options: [{ value: 1, label: "允许" }, { value: 2, label: "阻止" }] },
  { key: "ForceYouTubeRestrict", name: "YouTube 严格限制", category: "内容颗粒度（媒体体验）", description: "0=关 / 1=适度 / 2=最严格（家长控制与内容分级收口）", valueType: "enum", options: [{ value: 0, label: "关闭" }, { value: 1, label: "适度" }, { value: 2, label: "最严格" }] },
  { key: "RegisterProtocolHandlersEnabled", name: "注册协议处理器", category: "内容颗粒度（媒体体验）", description: "false=网页不可注册 mailto/tel/自定义协议处理器（防协议滥用与本地程序拉起）", valueType: "boolean" },
  { key: "EditFavoritesEnabled", name: "收藏编辑", category: "浏览体验", description: "false=禁止增删改收藏（新键名 —— 与 EditBookmarksEnabled 同义，兼容 Chromium 新版）", valueType: "boolean" },
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
    // r39：enum 严格类型（string 落空未拒 → 静默失效修复）
    // r40：enum 值类型跟随选项声明（number 枚举须 number；string 枚举如 DnsOverHttpsMode 须 string）
    if (item.valueType === "enum") {
      if (item.options && item.options.length > 0) {
        const wantNumber = typeof item.options[0].value === "number"
        if (wantNumber && t !== "number") {
          errors.push(`${key} 需要 number 值（枚举）`)
        } else if (!wantNumber && t !== "string") {
          errors.push(`${key} 需要 string 值（字符串枚举，如 ${JSON.stringify(item.options[0].value)}）`)
        } else if (!item.options.some((o) => o.value === value)) {
          errors.push(`${key} 的值 ${JSON.stringify(value)} 不在允许选项内（${item.options.map((o) => o.value).join("/")}）`)
        }
      }
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
    TaskManagerEndProcessEnabled: false, // r40：禁任务管理器结束进程（防杀渲染进程绕过审计/管控）
  }
}
