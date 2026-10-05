// r38 硬件申请链路 E2E —— resolveHardwarePolicy 授权感知全链
// 场景：demo 用户（默认硬件全关）→ GRANTED camera 申请 → resolve 出 enabled=true
//       → 过期后 → enabled 回落；REVOKED → 回落；账号级 vs 沙箱级作用域
import { db } from "../src/lib/db"

async function main() {
  const results: Array<[string, boolean, string]> = []
  const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "✓" : "✗"} ${n}${d ? "  [" + d + "]" : ""}`) }

  const demo = await db.user.findUnique({ where: { username: "demo" } })
  if (!demo) { console.error("demo 用户不存在"); process.exit(1) }

  // 清理旧测试数据
  await db.hardwareAccessRequest.deleteMany({ where: { userId: demo.id } })

  // ---- 1. 基线：无申请 → camera 关闭 ----
  const { resolveHardwarePolicy } = await import("../src/lib/hardware-perms")
  const base = await resolveHardwarePolicy(demo.id)
  check("基线：camera 关闭（默认 enabled=false）", base.policy.camera?.enabled === false)
  check("基线：无申请授权", Object.keys(base.granted ?? {}).length === 0)

  // ---- 2. GRANTED 账号级申请 → 生效 ----
  const req1 = await db.hardwareAccessRequest.create({
    data: { userId: demo.id, permId: "camera", mode: "GRANTED", workspaceId: null, decidedByName: "admin" },
  })
  const after1 = await resolveHardwarePolicy(demo.id)
  check("GRANTED 账号级 → camera enabled", after1.policy.camera?.enabled === true)
  check("granted 表包含 camera", !!after1.granted?.camera, `requestId=${after1.granted?.camera?.requestId?.slice(0, 8)}`)

  // ---- 3. 沙箱级作用域：其它沙箱不生效 ----
  const otherWs = await db.browserWorkspace.findFirst({ where: { userId: demo.id }, select: { id: true } })
  if (otherWs) {
    const scoped = await resolveHardwarePolicy(demo.id, otherWs.id)
    check("账号级授权对沙箱解析同样生效", scoped.policy.camera?.enabled === true)
  } else {
    check("（无 demo 沙箱 — 跳过作用域细分）", true)
  }

  const wsScoped = await db.hardwareAccessRequest.create({
    data: { userId: demo.id, permId: "microphone", mode: "GRANTED", workspaceId: "ws-nonexistent-x" },
  })
  void wsScoped
  const notMatched = await resolveHardwarePolicy(demo.id, "ws-different-y")
  check("沙箱级授权不匹配沙箱 → 不生效", notMatched.policy.microphone?.enabled === false)

  // ---- 4. 过期授权 → 回落 ----
  await db.hardwareAccessRequest.update({
    where: { id: req1.id },
    data: { expiresAt: new Date(Date.now() - 3600_000) },
  })
  const expired = await resolveHardwarePolicy(demo.id)
  check("过期 GRANTED → camera 回落关闭", expired.policy.camera?.enabled === false)

  // ---- 5. REVOKED → 回落 ----
  await db.hardwareAccessRequest.update({
    where: { id: req1.id },
    data: { mode: "REVOKED", expiresAt: null },
  })
  const revoked = await resolveHardwarePolicy(demo.id)
  check("REVOKED → camera 关闭", revoked.policy.camera?.enabled === false)

  // ---- 6. 未来生效期（未到）→ 不生效 ----
  await db.hardwareAccessRequest.update({
    where: { id: req1.id },
    data: { mode: "GRANTED", expiresAt: new Date(Date.now() + 86400_000) },
  })
  const future = await resolveHardwarePolicy(demo.id)
  check("GRANTED + 未来 24h 有效期 → camera enabled", future.policy.camera?.enabled === true)

  // ---- 7. 未知 permId → 忽略不崩 ----
  await db.hardwareAccessRequest.create({
    data: { userId: demo.id, permId: "nonexistent-perm", mode: "GRANTED" },
  })
  const withJunk = await resolveHardwarePolicy(demo.id)
  check("未知 permId 授权被忽略（不崩）", withJunk.policy.camera?.enabled === true && !withJunk.granted?.["nonexistent-perm"])

  // ---- 8. 静默模式（策略链直接放行 —— silent 开关独立字段）----
  await db.user.update({
    where: { id: demo.id },
    data: { hardwarePolicy: { usb: { enabled: true, silent: true, audit: true } } },
  })
  const silentRes = await resolveHardwarePolicy(demo.id)
  check("用户级静默放行：usb enabled+silent", silentRes.policy.usb?.enabled === true && silentRes.policy.usb?.silent === true)

  // ---- 清理 ----
  await db.hardwareAccessRequest.deleteMany({ where: { userId: demo.id } })
  await db.user.update({ where: { id: demo.id }, data: { hardwarePolicy: null } })
  const cleaned = await resolveHardwarePolicy(demo.id)
  check("清理后回落基线", cleaned.policy.usb?.enabled === false && cleaned.policy.camera?.enabled === false)

  const pass = results.filter((r) => r[1]).length
  console.log(`\n[hardware-request-e2e] ${pass}/${results.length} 通过`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1) })
