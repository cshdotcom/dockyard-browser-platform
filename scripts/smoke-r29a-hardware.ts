/**
 * r29-a 冒烟：17 项硬件权限四级策略链 + Chromium 策略注入 + 管理动作闭环
 * 覆盖：
 *   1. validateHardwarePolicy 校验向量（未知项/类型/清洗/空值）
 *   2. hardwareManagedPolicies 原生键生成（block/allow 值 + 平台通道项不生成键）
 *   3. 四级链解析（全局→组→用户→沙箱 逐层覆盖 + source 标记）
 *   4. resolveClipboardSync 硬件接管/旧版回退双语义
 *   5. 策略链 buildChromiumManagedPolicy 注入（硬件层可覆写模板同名键）
 *   6. 管理端 setHardwarePolicyAction（用户 scope 保存 + 审计 + 静默仅超管）
 *   7. refreshWorkspacePolicyFile 注入 DefaultCameraSetting（真实文件）
 */
import { PrismaClient } from "@prisma/client"
import { readFileSync, rmSync } from "fs"

const db = new PrismaClient()
const MASTER = "http://localhost:3000"
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

async function main() {
  console.log("== r29-a 冒烟：17 项硬件权限四级链 ==")

  // ---- 1. 纯函数向量（直接 import lib） ----
  const { validateHardwarePolicy, hardwareManagedPolicies, resolveHardwarePolicy, resolveClipboardSync } = await import("../src/lib/hardware-perms")

  const v1 = validateHardwarePolicy({ camera: { enabled: true }, usb: { audit: false } })
  check("校验：合法稀疏配置清洗", v1.ok && v1.clean?.camera?.enabled === true && v1.clean?.usb?.audit === false)

  const v2 = validateHardwarePolicy({ nonexist: { enabled: true } })
  check("校验：未知权限项拒绝", !v2.ok && v2.errors[0].includes("未知权限项"))

  const v3 = validateHardwarePolicy({ camera: { enabled: "yes" } })
  check("校验：非布尔值拒绝", !v3.ok && v3.errors[0].includes("必须为布尔"))

  const v4 = validateHardwarePolicy(null)
  check("校验：null 通过（继承）", v4.ok && v4.clean === null)

  // ---- 2. 原生键生成 ----
  const mg = hardwareManagedPolicies({
    camera: { enabled: true, audit: true, record: false, silent: false },
    microphone: { enabled: false, audit: true, record: false, silent: false },
    usb: { enabled: true, audit: true, record: false, silent: false },
    clipboardRead: { enabled: true, audit: true, record: false, silent: false }, // 平台通道 → 不生成键
  })
  check("原生键：摄像头允许=3（DefaultCameraSetting）", mg.DefaultCameraSetting === 3)
  check("原生键：麦克风拒绝=2（DefaultMicrophoneSetting）", mg.DefaultMicrophoneSetting === 2)
  check("原生键：USB 放行=0（WebUSBBlocked）", mg.WebUSBBlocked === 0)
  check("平台通道项不生成 Chromium 键（剪贴板）", !("ClipboardReadWrite" in mg) && Object.keys(mg).length === 3)

  // ---- 3. 四级链解析（构造真实数据） ----
  const qaGroup = await db.group.create({
    data: { name: `QA-R29A-组-${Date.now()}`, hardwarePolicy: { bluetooth: { enabled: true }, location: { enabled: false } } },
  })
  const qaUser = await db.user.create({
    data: {
      username: `qa-r29a-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true,
      hardwarePolicy: { camera: { enabled: true } },
    },
  })
  await db.groupUser.create({ data: { groupId: qaGroup.id, userId: qaUser.id } })

  const r1 = await resolveHardwarePolicy(qaUser.id)
  check("四级链：组级基线生效（蓝牙放行）", r1.policy.bluetooth?.enabled === true && r1.source === "USER" && r1.explicit.camera === true)
  check("四级链：组级（定位拒绝）+ 用户级（摄像头放行）合并", r1.policy.location?.enabled === false && r1.policy.camera?.enabled === true)
  check("四级链：未设置项走默认拒绝（麦克风）", r1.policy.microphone?.enabled === false)

  // 沙箱级覆盖（最强）
  const qaWs = await db.browserWorkspace.create({
    data: { name: `QA-R29A-沙箱-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "STOPPED", hardwareOverride: { camera: { enabled: false } } },
  })
  const r2 = await resolveHardwarePolicy(qaUser.id, qaWs.id)
  check("四级链：沙箱覆盖最强（摄像头改拒 + source=SANDBOX）", r2.policy.camera?.enabled === false && r2.source === "SANDBOX")
  check("四级链：下层值保持（蓝牙仍放行）", r2.policy.bluetooth?.enabled === true)

  // ---- 4. 剪贴板双语义 ----
  const c1 = await resolveClipboardSync(qaUser.id)
  check("剪贴板：硬件接管前回退旧版配置", c1.source === "legacy-config")

  await db.user.update({ where: { id: qaUser.id }, data: { hardwarePolicy: { clipboardRead: { enabled: true }, camera: { enabled: true } } } })
  const c2 = await resolveClipboardSync(qaUser.id)
  check("剪贴板：显式 clipboardRead → 硬件接管（开启）", c2.source !== "legacy-config" && c2.enabled === true)

  await db.user.update({ where: { id: qaUser.id }, data: { hardwarePolicy: { clipboardRead: { enabled: false }, clipboardWrite: { enabled: false } } } })
  const c3 = await resolveClipboardSync(qaUser.id)
  check("剪贴板：读写全关 → 透传关闭", !c3.enabled)

  // ---- 5. buildChromiumManagedPolicy 注入（硬件层覆写模板） ----
  const { buildChromiumManagedPolicy } = await import("../src/lib/network-policy")
  const managed = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: "" },
    extraManagedPolicy: { DefaultCameraSetting: 3, MetricsReportingEnabled: false }, // 模板想放行摄像头
    hardwareManagedPolicy: { DefaultCameraSetting: 2 }, // 硬件层收紧 → 覆写
  })
  check("注入：硬件层覆写模板同名键（摄像头 3→2）", managed.DefaultCameraSetting === 2)
  check("注入：模板非冲突键保留", managed.MetricsReportingEnabled === false)

  // ---- 6. 管理端核心（业务核心直调：与 Server Action 同一实现） ----
  const { setHardwarePolicyCore } = await import("../src/lib/hardware-policy-core")

  const adminOp = { userId: "smoke-admin", username: "admin", role: "ADMIN" }
  const superOp = { userId: "smoke-super", username: "superadmin", role: "SUPER_ADMIN" }

  // 6.1 ADMIN 保存用户级：含 silent 必须拒绝
  let denySilent = false
  try {
    await setHardwarePolicyCore(adminOp, { scope: "user", targetId: qaUser.id, policy: { camera: { enabled: true, silent: true } } })
  } catch (e) {
    denySilent = (e as Error).message.includes("超级管理员")
  }
  check("静默授权：非超管（ADMIN）被拒", denySilent)

  // ADMIN 改全局默认档也必须拒绝
  let denyGlobal = false
  try {
    await setHardwarePolicyCore(adminOp, { scope: "global", policy: { notifications: { enabled: true } } })
  } catch (e) {
    denyGlobal = (e as Error).message.includes("超级管理员")
  }
  check("全局默认档：非超管被拒", denyGlobal)

  // 6.2 ADMIN 保存用户级（无静默项 → 允许）
  const okSave = await setHardwarePolicyCore(adminOp, { scope: "user", targetId: qaUser.id, policy: { camera: { enabled: true, audit: true } } }).catch((e: Error) => e.message)
  check("用户级保存：ADMIN 允许（无静默项）", !(okSave instanceof Error) && typeof okSave === "object")

  const savedRow = await db.user.findUnique({ where: { id: qaUser.id }, select: { hardwarePolicy: true } })
  check("保存落库：稀疏覆盖值", (savedRow?.hardwarePolicy as { camera?: { enabled?: boolean } })?.camera?.enabled === true)

  const audit = await db.auditLog.findFirst({
    where: { operationType: "HARDWARE_POLICY_SET", resourceId: qaUser.id },
    orderBy: { createdAt: "desc" },
  })
  check("审计：HARDWARE_POLICY_SET 落库", !!audit && (audit.afterJson || "").includes("user"))

  // 6.3 超管保存全局默认档
  const gSave = await setHardwarePolicyCore(superOp, { scope: "global", policy: { notifications: { enabled: true } } }).catch((e: Error) => e.message)
  check("全局默认档：超管保存", !(gSave instanceof Error))
  const cfgRow = await db.systemConfig.findUnique({ where: { key: "hardware.defaults" } })
  check("全局默认档落库 hardware.defaults", (cfgRow?.valueJson || "").includes("notifications"))
  // 全局档对四级链生效
  const r3 = await resolveHardwarePolicy(qaUser.id)
  check("全局默认档参与四级解析（通知放行）", r3.policy.notifications?.enabled === true)
  // 清理：恢复空默认
  await setHardwarePolicyCore(superOp, { scope: "global", clear: true })
  const cfgRow2 = await db.systemConfig.findUnique({ where: { key: "hardware.defaults" } })
  let clearedVal = "{}"
  try { clearedVal = String(JSON.parse(String(cfgRow2?.valueJson ?? "{}")) || "{}") } catch { clearedVal = String(cfgRow2?.valueJson ?? "{}") }
  check("清除全局默认档（恢复空）", clearedVal.replace(/\s/g, "") === "{}")

  // 6.4 清除用户覆盖（完全继承）
  await setHardwarePolicyCore(adminOp, { scope: "user", targetId: qaUser.id, clear: true })
  const clearedRow = await db.user.findUnique({ where: { id: qaUser.id }, select: { hardwarePolicy: true } })
  check("清除用户覆盖（继承上层）", !clearedRow?.hardwarePolicy)
  // 重新写入 camera=true 供第 7 步注入断言
  await setHardwarePolicyCore(adminOp, { scope: "user", targetId: qaUser.id, policy: { camera: { enabled: true, audit: true } } })

  // ---- 7. refreshWorkspacePolicyFile 真实注入 ----
  const { ENV } = await import("../src/lib/env")
  const { refreshWorkspacePolicyFile } = await import("../src/lib/network-policy-apply")
  // 给沙箱一个 profileKey（hardeningJson）
  await db.browserWorkspace.update({
    where: { id: qaWs.id },
    data: { hardeningJson: { profileKey: `qar29a${Date.now().toString(36)}`, runtime: "embedded" } as object },
  })
  const ok = await refreshWorkspacePolicyFile(qaWs.id).catch(() => false)
  check("刷新：策略文件重写成功", ok === true)
  if (ok) {
    const { join } = await import("path")
    const dir = join(ENV.storageLocalPath.replace(/\/$/, ""), "netpolicy")
    const ws = await db.browserWorkspace.findUnique({ where: { id: qaWs.id }, select: { hardeningJson: true } })
    const pk = ((ws?.hardeningJson as { profileKey?: string }) || {}).profileKey || ""
    const content = readFileSync(join(dir, `ws-${pk}.json`), "utf-8")
    const parsed = JSON.parse(content) as Record<string, unknown>
    // 用户级 camera enabled=true（6.1 保存）+ 沙箱覆盖 enabled=false → 2
    check("注入：DefaultCameraSetting=2 落盘（沙箱覆盖拒）", parsed.DefaultCameraSetting === 2)
    check("注入：组级 WebBluetoothBlocked=0 落盘", parsed.WebBluetoothBlocked === 0)
    rmSync(join(dir, `ws-${pk}.json`), { force: true })
  }

  // ---- 清理 ----
  await db.browserWorkspace.delete({ where: { id: qaWs.id } })
  await db.groupUser.deleteMany({ where: { userId: qaUser.id } })
  await db.user.delete({ where: { id: qaUser.id } })
  await db.group.delete({ where: { id: qaGroup.id } })

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
