// CRX 插件库演示数据播种（真实 Chrome Web Store 扩展 ID + 标准 update_url）
// 覆盖演示场景：正常主源 / 私有镜像主源+商店备源（降级）/ 仅不可达源（全部失败告警）/ 黑名单 / 高危标记

import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()

const CHROME_UPDATE = "https://clients2.google.com/service/update2/crx"
const EDGE_UPDATE = "https://edge.microsoft.com/extensionstorestorecr/api/getupdates"
const PRIVATE_MIRROR = "http://crx-mirror.internal.example.com/service/update2/crx"

const LIB = [
  {
    crxId: "cjpalhdlnbpafiamejdnhcphjbkeiagm", // uBlock Origin（真实 ID）
    name: "uBlock Origin",
    description: "Wide-spectrum content blocker",
    zhNote: "广告拦截（办公标配）",
    tags: ["office"],
    permissions: ["all_urls", "webRequest", "webRequestBlocking", "storage"],
    updateUrl: CHROME_UPDATE,
    backupUpdateUrl: EDGE_UPDATE,
    allowIncognito: false,
    allowUserDisable: false,
    enabled: true,
  },
  {
    crxId: "fmkadmapgofadopljbjfkapdkoienihi", // React Developer Tools（真实 ID）
    name: "React Developer Tools",
    description: "Adds React debugging tools",
    zhNote: "前端开发调试（开发组）",
    tags: ["dev"],
    permissions: ["devtools", "storage", "tabs"],
    updateUrl: CHROME_UPDATE,
    backupUpdateUrl: null,
    allowIncognito: false,
    allowUserDisable: true,
    enabled: true,
  },
  {
    crxId: "aapbdbdomjkkjkaonfhkkikfgjllcleb", // Google Translate（真实 ID）
    name: "Google Translate",
    description: "View translations easily",
    zhNote: "网页翻译（多语言浏览）",
    tags: ["office"],
    permissions: ["tabs", "storage"],
    updateUrl: CHROME_UPDATE,
    backupUpdateUrl: null,
    allowIncognito: false,
    allowUserDisable: true,
    enabled: true,
  },
  {
    crxId: "dhdgffkkebhmkfjojejmpbldmpobfkfo", // Tampermonkey（真实 ID）
    name: "Tampermonkey",
    description: "Userscript manager",
    zhNote: "用户脚本管理（高危：可执行任意代码）",
    tags: ["highrisk"],
    permissions: ["all_urls", "storage", "tabs", "clipboardWrite"],
    updateUrl: CHROME_UPDATE,
    backupUpdateUrl: null,
    allowIncognito: false,
    allowUserDisable: true,
    enabled: true,
  },
  {
    // 私有镜像主源 + 商店备源：演示主源失败 → 备用源降级（BACKUP_RETRY）
    crxId: "nkbihfbeogaeaoehlefnkodbefgpgknn", // MetaMask（真实 ID，32位校验通过）
    name: "MetaMask（内网镜像分发）",
    description: "Crypto wallet（内网灰度）",
    zhNote: "私有镜像源演示：主源不可达时自动降级备用源",
    tags: ["highrisk", "ops"],
    permissions: ["storage", "tabs", "clipboardWrite"],
    updateUrl: PRIVATE_MIRROR,
    backupUpdateUrl: CHROME_UPDATE,
    allowIncognito: false,
    allowUserDisable: false,
    enabled: true,
  },
  {
    // 仅私有不可达源：演示双源全失败 → 告警 + 等待手动重试
    crxId: "bccgkmaklhcojhhfgfklefkkgjnefejf", // 真实格式 ID
    name: "内部审计助手（私有源）",
    description: "Internal audit helper",
    zhNote: "全失败告警演示：主备源均不可达",
    tags: ["ops"],
    permissions: ["tabs", "downloads"],
    updateUrl: PRIVATE_MIRROR,
    backupUpdateUrl: null,
    allowIncognito: false,
    allowUserDisable: true,
    enabled: true,
  },
  {
    // 库内禁用演示：被引用但已禁用 → 触发"禁用仍被引用"告警
    crxId: "gkbmnajbmkcpljcgbjkmfnfmaagjgbgc", // 真实格式 ID
    name: "Legacy Screenshot Tool",
    description: "Deprecated screenshot extension",
    zhNote: "库内禁用演示（禁用后引用沙箱停止安装并告警）",
    tags: ["office"],
    permissions: ["tabs", "downloads"],
    updateUrl: CHROME_UPDATE,
    backupUpdateUrl: null,
    allowIncognito: false,
    allowUserDisable: true,
    enabled: false,
  },
]

async function main() {
  for (const p of LIB) {
    const highRiskPerms = p.permissions.filter((x) => ["all_urls", "clipboardWrite", "webRequestBlocking", "downloads"].includes(x))
    await db.crxPlugin.upsert({
      where: { crxId: p.crxId },
      update: {
        name: p.name, description: p.description, zhNote: p.zhNote,
        tags: p.tags, permissions: p.permissions,
        updateUrl: p.updateUrl, backupUpdateUrl: p.backupUpdateUrl,
        allowIncognito: p.allowIncognito, allowUserDisable: p.allowUserDisable,
        highRisk: highRiskPerms.length > 0, highRiskReason: highRiskPerms,
        enabled: p.enabled,
      },
      create: {
        crxId: p.crxId, name: p.name, description: p.description, zhNote: p.zhNote,
        tags: p.tags, permissions: p.permissions,
        updateUrl: p.updateUrl, backupUpdateUrl: p.backupUpdateUrl,
        allowIncognito: p.allowIncognito, allowUserDisable: p.allowUserDisable,
        highRisk: highRiskPerms.length > 0, highRiskReason: highRiskPerms,
        enabled: p.enabled, createdByName: "seed", updatedByName: "seed",
      },
    })
    console.log(`plugin: ${p.name} (${p.crxId.slice(0, 8)}…) ${p.enabled ? "启用" : "禁用"}${highRiskPerms.length ? " [高危]" : ""}`)
  }

  // 全局层强制安装（3 个）
  const globalForce = ["cjpalhdlnbpafiamejdnhcphjbkeiagm", "aapbdbdomjkkjkaonfhkkikfgjllcleb", "dhdgffkkebhmkfjojejmpbldmpobfkfo"]
  for (const crxId of globalForce) {
    await db.crxPolicyEntry.upsert({
      where: { scopeType_scopeId_crxId: { scopeType: "GLOBAL", scopeId: "", crxId } },
      update: {},
      create: { scopeType: "GLOBAL", scopeId: "", crxId, createdByName: "seed", note: "全局基线插件" },
    })
  }
  console.log(`GLOBAL 强制安装：${globalForce.length} 个`)

  // 全局层黑名单（禁止安装）
  await db.crxBlocklistEntry.upsert({
    where: { scopeType_scopeId_crxId: { scopeType: "GLOBAL", scopeId: "", crxId: "gkbmnajbmkcpljcgbjkmfnfmaagjgbgc" } },
    update: {},
    create: { scopeType: "GLOBAL", scopeId: "", crxId: "gkbmnajbmkcpljcgbjkmfnfmaagjgbgc", note: "历史高危工具，全局禁止", createdByName: "seed" },
  })
  console.log("GLOBAL 黑名单：1 个")

  console.log("CRX 插件库种子完成")
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
