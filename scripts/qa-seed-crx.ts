// r13c QA：种子测试 CRX 插件（合法 Chrome 商店格式 ID）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  // Chrome Web Store 真实扩展 ID（uBlock Origin Lite）
  const crxId = "ddkjiahejlhfcafbddmgiahcphecmpfh"
  const existing = await db.crxPlugin.findUnique({ where: { crxId } })
  if (!existing) {
    await db.crxPlugin.create({
      data: {
        crxId,
        name: "uBlock Origin Lite",
        description: "广告拦截（权限宽泛：all_urls）",
        permissions: "all_urls,declarativeNetRequest",
        updateUrl: "https://clients2.google.com/service/update2/crx",
        highRisk: true,
        highRiskReason: ["all_urls"],
        enabled: true,
        createdByUserId: "seed",
      },
    })
    console.log("[qa-seed] 插件已入库")
  } else {
    console.log("[qa-seed] 插件已存在")
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
