// ============================================================
// r37：明文数据自动分类引擎（浏览历史 / 书签）
// 
// 企业管理模式的数据识别与解析：
//   · URL/域名/标题 → 16 个业务分类（搜索/社交/视频/购物/新闻/银行金融/政府/
//     邮箱/云盘/开发/AI/招聘/教育/游戏/成人/其它）
//   · 敏感级别三级（NORMAL/SENSITIVE/HIGH）——银行/政府/邮箱/云盘等涉及
//     明文凭据与商业数据，HIGH 级在管理端可单独审计与告警
//   · 规则形态：域名精确 → 域名后缀 → 关键词（标题/URL path），支持中文关键词
//   · 入库钩子（browsing-collector 写入时计算）+ 存量回填（管理端一键）
// ============================================================

export type DataCategory =
  | "SEARCH" | "SOCIAL" | "VIDEO" | "SHOPPING" | "NEWS" | "BANKING"
  | "GOV" | "EMAIL" | "CLOUD" | "DEV" | "AI" | "JOB" | "EDU"
  | "GAME" | "ADULT" | "OTHER"

export type DataSensitivity = "NORMAL" | "SENSITIVE" | "HIGH"

interface CategoryRule {
  category: DataCategory
  /** 精确域名（含子域名自动匹配） */
  domains?: string[]
  /** 域名后缀匹配（如 .edu.cn） */
  domainSuffixes?: string[]
  /** 标题/URL 关键词（小写包含匹配） */
  keywords?: string[]
}

// ---- 分类规则表（顺序即优先级：精确域名 > 后缀 > 关键词）----
const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "BANKING",
    domains: [
      "icbc.com.cn", "ccb.com", "abchina.com", "boc.cn",
      "cmbchina.com", "cib.com.cn", "spdb.com.cn", "cebbank.com", "gdb.com.cn",
      "pingan.com", "hsbc.com.cn", "citibank.com", "chase.com", "bankofamerica.com",
      "wellsfargo.com", "paypal.com", "stripe.com", "alipay.com", "tenpay.com", "unionpay.com",
    ],
    keywords: ["银行", "网银", "bank", "credit card", "信用卡", "贷款", "loan", "对公", "转账汇款", "payment", "tax.gov"],
  },
  {
    category: "CLOUD",
    domains: ["pan.baidu.com", "cloud.189.cn", "aliyundrive.com", "alipan.com", "quark.cn", "onedrive.com", "onedrive.live.com", "dropbox.com", "box.com", "googledrive.com", "drive.google.com", "mega.nz", "4shared.com"],
    keywords: ["网盘", "云盘", "cloud drive", "file share", "文件共享", "dropbox"],
  },
  {
    category: "GOV",
    domainSuffixes: [".gov.cn", ".gov", ".gov.uk", ".gov.au", ".gov.jp", ".gouv.fr", ".europa.eu"],
    domains: ["gov.cn"],
    keywords: ["政府", "政务", "gouvernement", "公安", "工商", "税务局", "法院", "procurement"],
  },
  {
    category: "EMAIL",
    domains: [
      "mail.google.com", "outlook.com", "outlook.office.com", "live.com", "mail.qq.com",
      "mail.163.com", "mail.126.com", "mail.sina.com.cn", "exmail.qq.com", "yahoo.com",
      "proton.me", "protonmail.com", "zoho.com", "fastmail.com", "gmx.com", "mail.ru",
    ],
    keywords: ["邮箱", "mail", "webmail", "inbox", "email"],
  },
  {
    category: "SEARCH",
    domains: ["google.com", "bing.com", "baidu.com", "duckduckgo.com", "search.yahoo.com", "sogou.com", "yandex.com", "ecosia.org", "startpage.com", "searx"],
    keywords: ["搜索", "search?q", "search?query"],
  },
  {
    category: "SOCIAL",
    domains: [
      "facebook.com", "x.com", "twitter.com", "instagram.com", "tiktok.com", "douyin.com",
      "weibo.com", "weibo.cn", "renren.com", "zhihu.com", "linkedin.com", "reddit.com",
      "t.me", "telegram.org", "vk.com", "threads.net", "pinterest.com", "discord.com", "discord.gg",
    ],
    keywords: ["社交", "social", "朋友圈", "微博", "论坛"],
  },
  {
    category: "VIDEO",
    domains: ["youtube.com", "youtu.be", "bilibili.com", "v.qq.com", "youku.com", "iqiyi.com", "mgtv.com", "netflix.com", "primevideo.com", "hulu.com", "disneyplus.com", "twitch.tv", "douyu.com", "huajiao.com", "ixigua.com"],
    keywords: ["视频", "video", "直播", "live", "影视"],
  },
  {
    category: "SHOPPING",
    domains: ["taobao.com", "tmall.com", "jd.com", "pinduoduo.com", "amazon.com", "amazon.cn", "ebay.com", "aliexpress.com", "walmart.com", "shopify.com", "etsy.com", "temu.com", "shein.com", "gome.com.cn", "suning.com", "mi.com"],
    keywords: ["购物", "商城", "shop", "store", "旗舰店", "订单", "购物车", "cart"],
  },
  {
    category: "NEWS",
    domains: ["news.qq.com", "news.sina.com.cn", "news.163.com", "people.com.cn", "xinhuanet.com", "chinanews.com", "cctv.com", "thepaper.cn", "zaobao.com", "bbc.com", "cnn.com", "reuters.com", "nytimes.com", "wsj.com", "ft.com", "bloomberg.com"],
    keywords: ["新闻", "news", "资讯", "头条", "报", "press"],
  },
  {
    category: "DEV",
    domains: ["github.com", "gitlab.com", "gitee.com", "stackoverflow.com", "stackexchange.com", "bitbucket.org", "npmjs.com", "npm.org", "pypi.org", "maven.apache.org", "hub.docker.com", "developer.mozilla.org", "cnblogs.com", "csdn.net", "juejin.cn", "segmentfault.com", "v2ex.com", "rustup.rs", "crates.io", "pkg.go.dev", "registry.npmjs.org"],
    keywords: ["开发", "developer", "编程", "code", "api docs", "documentation", "编译", "repo", "git"],
  },
  {
    category: "AI",
    domains: ["chat.openai.com", "chatgpt.com", "openai.com", "anthropic.com", "claude.ai", "gemini.google.com", "bard.google.com", "copilot.microsoft.com", "huggingface.co", "kaggle.com", "midjourney.com", "runwayml.com", "stable Diffusion", "kimi.moonshot.cn", "moonshot.cn", "baichuan-ai.com", "chatglm.cn", "bigmodel.cn", "deepseek.com", "qianwen.aliyun.com", "yiyan.baidu.com", "xinya.baidu.com", "poe.com", "perplexity.ai"],
    keywords: ["ai", "人工智能", "gpt", "llm", "machine learning", "深度学习"],
  },
  {
    category: "JOB",
    domains: ["zhipin.com", "51job.com", "liepin.com", "lagou.com", "linkedin.com/jobs", "indeed.com", "glassdoor.com", "monster.com"],
    keywords: ["招聘", "求职", "jobs", "career", "简历", "resume", "hiring"],
  },
  {
    category: "EDU",
    domainSuffixes: [".edu", ".edu.cn", ".ac.uk", ".ac.jp", ".ac.kr", ".edu.au"],
    domains: ["coursera.org", "edx.org", "udemy.com", "mooc.cn", "icourse163.org", "xuetangx.com", "study.163.com", "duolingo.com"],
    keywords: ["课程", "学习", "course", "学习平台", "mooc", "大学", "university", "学堂"],
  },
  {
    category: "GAME",
    domains: ["steamcommunity.com", "store.steampowered.com", "epicgames.com", "battle.net", "roblox.com", "minecraft.net", "leagueoflegends.com", "lol.qq.com", "wegame.com.cn", "garena.com"],
    keywords: ["游戏", "game", "steam", "电竞", "游乐园"],
  },
  {
    category: "ADULT",
    domains: ["pornhub.com", "xvideos.com", "xhamster.com", "onlyfans.com", "redtube.com", "youporn.com"],
    keywords: ["adult", "nsfw", "porn"],
  },
]

// ---- 敏感级别规则（分类之上的叠加判定）----
// HIGH：银行/政府 —— 明文凭据/资金/身份强相关
// SENSITIVE：邮箱/云盘/云协作 —— 商业数据与账号凭据相关
const SENSITIVITY_BY_CATEGORY: Partial<Record<DataCategory, DataSensitivity>> = {
  BANKING: "HIGH",
  GOV: "HIGH",
  EMAIL: "SENSITIVE",
  CLOUD: "SENSITIVE",
}

// 额外高敏关键词（URL/标题命中即至少 SENSITIVE；登录/账户/密码/身份证形态）
const HIGH_SENSITIVE_KEYWORDS = [
  "login", "signin", "sign-in", "登录", "登陆", "password", "passwd", "密码",
  "account", "账户", "身份证", "passport", "id-card", "verify", "验证",
  "payment", "支付", "checkout", "结算", "creditcard",
]
const SENSITIVE_KEYWORDS = ["invoice", "发票", "合同", "contract", "salary", "工资", "hr", "oa", "vpn", "admin"]

/** 分类结果（纯函数；无 IO —— 采集热路径每条 ≤ 数百次字符串比较）*/
export function classifyEntry(url: string, title?: string | null): {
  category: DataCategory
  sensitivity: DataSensitivity
} {
  let host = ""
  let pathQuery = ""
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    pathQuery = (u.pathname + u.search).toLowerCase()
  } catch {
    // 非 URL 形态（本地路径等）—— 退化为全文小写匹配
    host = ""
    pathQuery = url.toLowerCase()
  }
  const titleLower = (title || "").toLowerCase()

  // 1) 精确域名 / 后缀 → 首个命中分类
  let category: DataCategory = "OTHER"
  outer: for (const rule of CATEGORY_RULES) {
    if (rule.domains) {
      for (const d of rule.domains) {
        if (host === d || host.endsWith(`.${d}`)) { category = rule.category; break outer }
      }
    }
  }
  // 2) 域名后缀（.gov.cn / .edu.cn 等机构形态）
  if (category === "OTHER") {
    outer2: for (const rule of CATEGORY_RULES) {
      if (rule.domainSuffixes) {
        for (const s of rule.domainSuffixes) {
          if (host.endsWith(s)) { category = rule.category; break outer2 }
        }
      }
    }
  }
  // 3) 关键词（标题 + URL path）
  if (category === "OTHER") {
    const text = `${titleLower} ${pathQuery}`
    outer3: for (const rule of CATEGORY_RULES) {
      if (rule.keywords) {
        for (const k of rule.keywords) {
          if (text.includes(k)) { category = rule.category; break outer3 }
        }
      }
    }
  }

  // 敏感级别：分类基础 + 关键词升级
  let sensitivity: DataSensitivity = SENSITIVITY_BY_CATEGORY[category] || "NORMAL"
  const fullText = `${titleLower} ${pathQuery}`
  if (HIGH_SENSITIVE_KEYWORDS.some((k) => fullText.includes(k))) {
    sensitivity = "HIGH"
  } else if (sensitivity === "NORMAL" && SENSITIVE_KEYWORDS.some((k) => fullText.includes(k))) {
    sensitivity = "SENSITIVE"
  }
  return { category, sensitivity }
}

/** 分类中文名（前端展示） */
export const CATEGORY_LABELS: Record<DataCategory, string> = {
  SEARCH: "搜索引擎", SOCIAL: "社交媒体", VIDEO: "视频娱乐", SHOPPING: "购物电商",
  NEWS: "新闻资讯", BANKING: "银行金融", GOV: "政府政务", EMAIL: "邮箱邮件",
  CLOUD: "云盘存储", DEV: "开发技术", AI: "AI 工具", JOB: "招聘求职",
  EDU: "教育学习", GAME: "游戏", ADULT: "成人内容", OTHER: "其它",
}

export const SENSITIVITY_LABELS: Record<DataSensitivity, string> = {
  NORMAL: "普通", SENSITIVE: "敏感", HIGH: "高敏",
}

/** 分类列表（统计/筛选用） */
export const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as DataCategory[]
export const ALL_SENSITIVITIES = Object.keys(SENSITIVITY_LABELS) as DataSensitivity[]
