// QA 23-d 清理脚本（幂等，可重复执行）
// 范围：
//  1. demo User.tokenPolicy → null（用户级覆盖已通过「清除全部覆盖」复位，双保险）
//  2. 默认用户组 Group.tokenPolicy → null（撤销 QA ② 的组级 rateLimitPerMin=100 基线）
//  3. QA ③ 的 ApiToken「QA23D测试密钥」物理删除（QA 产物，非平台数据）+ 关联调用日志
//  4. demo 密码恢复种子值 Demo@2026（QA 期间误跑了历史脚本 qa-demo-pwd.ts 改成了 Demo@2026r14）
//  5. UserBehaviorProfile.resourcesCreated 回退 1（创建 QA 令牌时 trackBehavior 计数）
//  6. 本轮 QA 产生的审计行（USER_TOKEN_POLICY ×3 / GROUP_TOKEN_POLICY / TOKEN_ADMIN_CREATE / TOKEN_ADMIN_UPDATE）
//  7. 本轮 QA 产生的安全事件（SESSION_RECORD_DELETE ×1）
//  8. 残留受信任测试设备（qa23d-test-device，UI 删除后应已归零）
// 说明：QA ④ 删除的 1 条 admin 历史已撤销 LoginSession 记录（cmur1pni…，本就是死数据）为功能
//       验证对象，不恢复（该功能语义即为清理下线记录）。
import bcrypt from "bcryptjs"
import { db } from "../src/lib/db"

async function main() {
  const demo = await db.user.findUnique({ where: { username: "demo" }, select: { id: true, tokenPolicy: true, passwordHash: true } })
  if (!demo) throw new Error("demo 不存在")

  // 1. 用户级覆盖复位
  if (demo.tokenPolicy) {
    await db.user.update({ where: { id: demo.id }, data: { tokenPolicy: null } })
    console.log("[1] demo.tokenPolicy 已置 null（原值:", JSON.stringify(demo.tokenPolicy), "）")
  } else {
    console.log("[1] demo.tokenPolicy 已为 null")
  }

  // 2. 组级基线复位
  const grp = await db.group.findFirst({ where: { name: "默认用户组", deletedAt: null }, select: { id: true, tokenPolicy: true } })
  if (grp?.tokenPolicy) {
    await db.group.update({ where: { id: grp.id }, data: { tokenPolicy: null } })
    console.log("[2] 默认用户组.tokenPolicy 已置 null（原值:", JSON.stringify(grp.tokenPolicy), "）")
  } else {
    console.log("[2] 默认用户组.tokenPolicy 已为 null")
  }

  // 3. QA 令牌删除（含调用日志）
  const qaTokens = await db.apiToken.findMany({ where: { OR: [{ name: "QA23D测试密钥" }, { tokenPrefix: "dy_75021" }] }, select: { id: true, name: true } })
  for (const t of qaTokens) {
    const logs = await db.apiTokenCallLog.deleteMany({ where: { tokenId: t.id } })
    await db.apiToken.delete({ where: { id: t.id } })
    console.log(`[3] 已删除 QA 令牌「${t.name}」（调用日志 ${logs.count} 条）`)
  }
  if (qaTokens.length === 0) console.log("[3] 无残留 QA 令牌")

  // 4. demo 密码恢复种子值
  const matchesSeed = await bcrypt.compare("Demo@2026", demo.passwordHash || "")
  if (!matchesSeed) {
    await db.user.update({ where: { id: demo.id }, data: { passwordHash: await bcrypt.hash("Demo@2026", 12) } })
    console.log("[4] demo 密码已恢复为种子值 Demo@2026")
  } else {
    console.log("[4] demo 密码已是种子值")
  }

  // 5. 行为画像计数回退
  const prof = await db.userBehaviorProfile.findUnique({ where: { userId: demo.id } })
  if (prof && prof.resourcesCreated > 0) {
    await db.userBehaviorProfile.update({ where: { userId: demo.id }, data: { resourcesCreated: { decrement: 1 } } })
    console.log(`[5] demo resourcesCreated 回退 1（${prof.resourcesCreated} → ${prof.resourcesCreated - 1}）`)
  } else {
    console.log("[5] demo 行为画像无需回退")
  }

  // 6. QA 审计行清理
  const a1 = await db.auditLog.deleteMany({ where: { operationType: "USER_TOKEN_POLICY", resourceName: "demo" } })
  const a2 = await db.auditLog.deleteMany({ where: { operationType: "GROUP_TOKEN_POLICY", resourceName: "默认用户组" } })
  const a3 = await db.auditLog.deleteMany({ where: { operationType: { in: ["TOKEN_ADMIN_CREATE", "TOKEN_ADMIN_UPDATE"] }, resourceName: "QA23D测试密钥" } })
  console.log(`[6] 审计清理：USER_TOKEN_POLICY ${a1.count} / GROUP_TOKEN_POLICY ${a2.count} / TOKEN_ADMIN_* ${a3.count}`)

  // 7. QA 安全事件清理
  const s1 = await db.securityEvent.deleteMany({ where: { eventType: "SESSION_RECORD_DELETE", detail: { contains: "删除 1 条已下线/过期登录会话记录" } } })
  console.log(`[7] 安全事件清理：SESSION_RECORD_DELETE ${s1.count}`)

  // 8. 残留测试设备
  const d1 = await db.trustedDevice.deleteMany({ where: { deviceId: "qa23d-test-device" } })
  console.log(`[8] 残留测试设备清理：${d1.count}`)

  // ---- 终态断言 ----
  const demoAfter = await db.user.findUnique({ where: { username: "demo" }, select: { tokenPolicy: true } })
  const grpAfter = await db.group.findFirst({ where: { name: "默认用户组" }, select: { tokenPolicy: true } })
  const tokensAfter = await db.apiToken.findMany({ where: { deletedAt: null }, select: { name: true, rateLimitPerMin: true } })
  const auditsLeft = await db.auditLog.count({ where: { operationType: { in: ["USER_TOKEN_POLICY", "GROUP_TOKEN_POLICY", "TOKEN_ADMIN_CREATE", "TOKEN_ADMIN_UPDATE"] } } })
  const pass =
    demoAfter?.tokenPolicy == null &&
    grpAfter?.tokenPolicy == null &&
    tokensAfter.every((t) => t.name !== "QA23D测试密钥") &&
    auditsLeft === 0
  console.log("终态：demo.tokenPolicy =", demoAfter?.tokenPolicy, "；group.tokenPolicy =", grpAfter?.tokenPolicy, "；令牌数 =", tokensAfter.length, "；QA 审计残留 =", auditsLeft)
  console.log(pass ? "CLEANUP PASS" : "CLEANUP FAIL")
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
