// QA r26：创建带完整 hardening/networkPolicy 快照的测试工作区（供基线扫描/防篡改/克隆验证）
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()

async function main() {
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  if (!demo) throw new Error("demo 不存在")
  // 清理旧 QA 数据
  await db.browserWorkspace.deleteMany({ where: { name: { startsWith: "QA-R26" } } })

  const ws = await db.browserWorkspace.create({
    data: {
      uuid: `qa-r26-${Date.now().toString(36)}`,
      name: "QA-R26-基线沙箱",
      mode: "novnc_full",
      status: "RUNNING",
      userId: demo.id,
      tags: [],
      hardeningJson: {
        profileKey: "qa-r26-profile",
        readOnlyRootfs: true,
        capDrop: "ALL",
        noNewPrivileges: true,
        runtime: "embedded",
        clipboardIsolated: true,
      },
      networkPolicyJson: {
        allowInternalNetwork: false,
        allowSecureLocationAccess: false,
        source: "GLOBAL_DEFAULT",
        enforcedAt: new Date().toISOString(),
      },
    },
  })
  console.log("已创建:", ws.id, ws.name)

  // 策略文件（防篡改对账素材）：写入真实文件 + 登记哈希
  const { writeNetworkPolicyFile } = await import("../src/lib/network-policy")
  const path = await writeNetworkPolicyFile("qa-r26-profile", {
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
  })
  console.log("策略文件:", path)

  const { rememberPolicyFileHash } = await import("../src/lib/crx-lifecycle")
  const registered = await rememberPolicyFileHash(ws.id, path!)
  console.log("哈希登记:", registered)

  // 沙箱级 CRX 策略（克隆同步验证素材）
  await db.crxPolicyEntry.create({
    data: { scopeType: "SANDBOX", scopeId: ws.id, crxId: "b".repeat(32), note: "QA-R26 克隆素材", lockedVersion: "1.0.0" },
  })
  console.log("CRX 策略条目已建")
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
