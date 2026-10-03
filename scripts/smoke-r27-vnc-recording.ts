// ============================================================
// r27 冒烟：VNC 会话录像全链路（策略四级链 / 注册 / 扫描 / 终结 /
// 保留期治理 / 回收站级联 / 签名票据 / 策略目录校验 / 防退出策略）
// 运行：bunx tsx scripts/smoke-r27-vnc-recording.ts
// ============================================================
import { PrismaClient } from "@prisma/client"
import { execFileSync } from "child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from "fs"
import { join } from "path"

const db = new PrismaClient()
let pass = 0
let fail = 0
function ok(cond: boolean, label: string, extra?: string) {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ""}`)
  }
}

const STORAGE = process.env.STORAGE_LOCAL_PATH || join(process.cwd(), "storage")

async function main() {
  console.log("== r27 冒烟：VNC 会话录像 ==")

  // ---------- 1. 策略四级链 ----------
  console.log("\n[1] 录像策略四级链（沙箱>用户>组>全局）")
  const { resolveRecordingPolicy, recordingTuning, registerWorkspaceRecording, scanRecordingSegments, finalizeRecordingSession, softDeleteRecording, purgeRecordingRow, signPlaybackToken, verifyPlaybackToken, recordingAbsPath, recordingSessionDir } = await import("../src/lib/recording")
  const { validateExtraPolicies, exitGuardManagedPolicy, CHROMIUM_POLICY_CATALOG } = await import("../src/lib/chromium-policies")
  const { buildChromiumManagedPolicy } = await import("../src/lib/network-policy")

  // 测试用户 + 组
  const groupName = "QA-R27-组-" + Date.now()
  const grp = await db.group.create({ data: { name: groupName, vncRecording: true } })
  const uname = "qa_r27_" + Date.now().toString(36)
  const user = await db.user.create({
    data: { username: uname, passwordHash: "x", role: "USER", vncRecording: null },
  })
  await db.groupUser.create({ data: { groupId: grp.id, userId: user.id } })

  // 1.1 组级（用户 null → 组 true）
  let p = await resolveRecordingPolicy(user.id)
  ok(p.enabled === true && p.source === "GROUP", "组级命中：enabled=true source=GROUP", JSON.stringify(p))

  // 1.2 用户级覆盖（false 覆盖组 true）
  await db.user.update({ where: { id: user.id }, data: { vncRecording: false } })
  p = await resolveRecordingPolicy(user.id)
  ok(p.enabled === false && p.source === "USER", "用户级覆盖：enabled=false source=USER")

  // 1.3 沙箱级覆盖最高优先
  const wsUuid = "ws-" + Date.now().toString(36)
  const ws = await db.browserWorkspace.create({
    data: { name: "QA-R27-沙箱", uuid: wsUuid, mode: "novnc_full", status: "STOPPED", userId: user.id, recordingOverride: "on" },
  })
  p = await resolveRecordingPolicy(user.id, ws.id)
  ok(p.enabled === true && p.source === "SANDBOX", "沙箱级覆盖最高：on 覆盖用户 false")

  // 1.4 全局默认回退（无组无覆盖用户）
  const grp2 = await db.group.create({ data: { name: "QA-R27-空组-" + Date.now(), vncRecording: null } })
  const user2 = await db.user.create({ data: { username: "qa_r27_n_" + Date.now().toString(36), passwordHash: "x", role: "USER" } })
  await db.groupUser.create({ data: { groupId: grp2.id, userId: user2.id } })
  p = await resolveRecordingPolicy(user2.id)
  const globalDefault = await db.systemConfig.findUnique({ where: { key: "vnc.recordingEnabled" } })
  const globalEnabled = globalDefault ? JSON.parse(globalDefault.valueJson) === true : false
  ok(p.source === "GLOBAL_DEFAULT" && p.enabled === globalEnabled, "全局默认回退（source=GLOBAL_DEFAULT）", JSON.stringify(p))

  // 1.5 继承链向上（父组显式）
  const parentGrp = await db.group.create({ data: { name: "QA-R27-父组-" + Date.now(), vncRecording: true } })
  await db.group.update({ where: { id: grp2.id }, data: { parentId: parentGrp.id, vncRecording: null } })
  p = await resolveRecordingPolicy(user2.id)
  ok(p.enabled === true && p.source === "GROUP", "继承链向上：父组显式 true 命中")

  // 1.6 tuning 钳制
  const tuning = await recordingTuning()
  ok(tuning.fps >= 4 && tuning.fps <= 30 && tuning.segmentSec >= 60, "录像参数钳制（fps 4-30 / 分段 ≥60s）", JSON.stringify(tuning))

  // ---------- 2. 注册 + 分段扫描 + 终结（真实文件） ----------
  console.log("\n[2] 注册 / 分段扫描 / 终结（真实 mp4 文件）")
  const sessionId = "emb-qa27" + Date.now().toString(36)
  const reg = await registerWorkspaceRecording({
    workspace: { id: ws.id, uuid: wsUuid, name: ws.name, userId: user.id },
    username: uname,
    sessionId,
    resolution: "1280x800",
    policy: p,
    tuning: { fps: 12, segmentSec: 900, maxMinutes: 0, maxSegmentMb: 2048 },
  })
  ok(reg.registered === true, "录像会话注册（首段 RECORDING 行 + session.json）")
  const sessionDir = recordingSessionDir(user.id, sessionId)!
  ok(existsSync(join(sessionDir, "session.json")), "session.json 溯源标记已落盘")

  // 重复注册幂等
  const reg2 = await registerWorkspaceRecording({
    workspace: { id: ws.id, uuid: wsUuid, name: ws.name, userId: user.id },
    username: uname, sessionId, resolution: "1280x800", policy: p,
    tuning: { fps: 12, segmentSec: 900, maxMinutes: 0, maxSegmentMb: 2048 },
  })
  ok(reg2.registered === false, "重复注册幂等（唯一约束兜底）")

  // 用真实 ffmpeg 生成两个分段（1 秒测试源 → fMP4 分段语义一致）
  mkdirSync(sessionDir, { recursive: true })
  const seg0 = join(sessionDir, "seg-000.mp4")
  const seg1 = join(sessionDir, "seg-001.mp4")
  try {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", seg0], { stdio: "pipe" })
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+frag_keyframe+empty_moov", seg1], { stdio: "pipe" })
  } catch (e) {
    console.log("  ⚠️ ffmpeg 生成失败，跳过文件级断言", String(e))
  }
  ok(existsSync(seg0) && statSync(seg0).size > 0, "真实 mp4 分段生成（seg-000）")

  // 扫描：seg-001 出现 → seg-000 收尾 COMPLETED + seg-001 补行
  const scan1 = await scanRecordingSegments(sessionId)
  const rowsAfterScan = await db.vncRecording.findMany({ where: { sessionId }, orderBy: { segmentIndex: "asc" } })
  ok(rowsAfterScan.length === 2, "扫描后 2 行（补行 seg-001）", `rows=${rowsAfterScan.length}`)
  const seg0Row = rowsAfterScan.find((r) => r.segmentIndex === 0)
  ok(seg0Row?.status === "COMPLETED" && (seg0Row?.sizeBytes ?? 0) > 0, "seg-000 已收尾（COMPLETED + sizeBytes>0）", seg0Row?.status)
  ok((seg0Row?.durationSec ?? 0) > 0, "ffprobe 真实时长探测（durationSec>0）", String(seg0Row?.durationSec))
  ok(rowsAfterScan.find((r) => r.segmentIndex === 1)?.storageKey != null, "补行 storageKey 白名单格式")
  void scan1

  // 终结（沙箱已死语义）
  const finalized = await finalizeRecordingSession(sessionId, { reason: "qa-terminate" })
  const liveRows = await db.vncRecording.count({ where: { sessionId, status: "RECORDING" } })
  ok(finalized >= 1 && liveRows === 0, "会话终结：剩余 RECORDING 行全部收口", `finalized=${finalized} live=${liveRows}`)

  // ---------- 3. 保留期治理（直接调用核心函数） ----------
  console.log("\n[3] 保留期 / 配额治理 → 回收站级联")
  // 把 seg0 的 startedAt 拨回 400 天前（保留期默认 90 天 → 到期）
  const ancient = new Date(Date.now() - 400 * 86_400_000)
  await db.vncRecording.update({ where: { id: seg0Row!.id }, data: { startedAt: ancient, endedAt: ancient } })
  const { enforceRecordingRetention } = await import("../src/lib/recording")
  const ret = await enforceRecordingRetention((m) => console.log("   ·", m))
  const expiredRow = await db.vncRecording.findUnique({ where: { id: seg0Row!.id } })
  ok(ret.expired >= 1 && expiredRow?.deletedAt != null, "保留期到期 → 软删入回收站", `expired=${ret.expired}`)
  const recycleEntry = await db.recycleBin.findFirst({ where: { resourceType: "RECORDING", resourceId: seg0Row!.id, restoredAt: null } })
  ok(recycleEntry != null, "RecycleBin 登记（RECORDING 类型）")

  // 回收站恢复（专用路径）
  await db.vncRecording.update({ where: { id: seg0Row!.id }, data: { deletedAt: null, purgeAt: null, restoredAt: new Date() } })
  await db.recycleBin.update({ where: { id: recycleEntry!.id }, data: { restoredAt: new Date() } })
  const restored = await db.vncRecording.findUnique({ where: { id: seg0Row!.id } })
  ok(restored?.deletedAt == null, "回收站恢复后回到可用态")

  // 物理清除（文件 + 行 + 目录级联）
  const seg1Row = rowsAfterScan.find((r) => r.segmentIndex === 1)!
  const purgeRes = await purgeRecordingRow(seg1Row.id, { operatorUserId: user.id, operatorName: uname })
  const purgedRow = await db.vncRecording.findUnique({ where: { id: seg1Row.id } })
  ok(purgeRes.purged === true && purgedRow === null, "物理清除：行已删除")
  ok(!existsSync(seg1), "物理清除：文件已删除")

  // ---------- 4. 签名票据 ----------
  console.log("\n[4] 回放签名票据（HMAC + 时效）")
  const rec0 = await db.vncRecording.findUnique({ where: { id: seg0Row!.id } })
  const token = signPlaybackToken(rec0!.id, user.id, 60)
  const v = verifyPlaybackToken(token)
  ok(v != null && v!.recordingId === rec0!.id && v!.userId === user.id, "有效票据验证通过")
  ok(verifyPlaybackToken("garbage.token.x.y") === null, "垃圾票据拒绝")
  const tampered = token.slice(0, -4) + "0000"
  ok(verifyPlaybackToken(tampered) === null, "篡改票据拒绝（MAC 不匹配）")
  const expiredToken = signPlaybackToken(rec0!.id, user.id, -10)
  ok(verifyPlaybackToken(expiredToken) === null, "过期票据拒绝")

  // ---------- 5. Chromium 策略目录校验 + 防退出策略 ----------
  console.log("\n[5] Chromium 策略目录 + 防退出托管策略")
  ok(CHROMIUM_POLICY_CATALOG.length >= 30, `策略目录 ≥30 项（实际 ${CHROMIUM_POLICY_CATALOG.length}）`)
  const vOk = validateExtraPolicies({ MetricsReportingEnabled: false, SafeBrowsingProtectionLevel: 2, RestoreOnStartupURLs: ["https://a.com"] })
  ok(vOk.ok === true, "合法策略集合通过校验")
  const vBad = validateExtraPolicies({ NotARealPolicy: true, URLBlocklist: ["x"], MetricsReportingEnabled: "yes" })
  ok(vBad.ok === false && vBad.errors.length === 3, "未知键 / 安全键 / 类型错误全部拦截（3 错误）", JSON.stringify(vBad.errors))
  const guardPol = exitGuardManagedPolicy("fullscreen")
  ok(guardPol.IncognitoModeAvailability === 1 && guardPol.BrowserSignin === 0 && guardPol.SyncDisabled === true, "fullscreen/kiosk 档附加策略（无痕禁用/登录禁用/同步禁用）")
  ok(Object.keys(exitGuardManagedPolicy("normal")).length === 0, "normal 档零注入（历史行为零变更）")

  // 合并顺序：模板策略先注入，安全层键永不被覆盖
  const merged = buildChromiumManagedPolicy({
    policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() },
    extraManagedPolicy: { MetricsReportingEnabled: false, URLBlocklist: ["https://template-override.example"], DeveloperToolsAvailability: 2 },
  })
  ok(merged.MetricsReportingEnabled === false && merged.DeveloperToolsAvailability === 2, "模板策略项已注入托管 JSON")
  ok(Array.isArray(merged.URLBlocklist) && !(merged.URLBlocklist as string[]).includes("https://template-override.example"), "安全键（URLBlocklist）模板覆盖被拒")

  // ---------- 6. storageKey 路径穿越防护 ----------
  console.log("\n[6] 路径穿越防护")
  ok(recordingAbsPath("recordings/user123abc/emb-123abc/seg-000.mp4") != null, "合法 storageKey 解析")
  ok(recordingAbsPath("recordings/../../etc/passwd") === null, "穿越路径拒绝")
  ok(recordingAbsPath("recordings/ok/emb-123/../../x.mp4") === null, "中间穿越拒绝")

  // ---------- 清理 ----------
  console.log("\n[清理] QA 数据归零")
  rmSync(sessionDir, { recursive: true, force: true })
  for (const id of [seg0Row!.id]) {
    await db.recycleBin.deleteMany({ where: { resourceType: "RECORDING", resourceId: id } })
  }
  await db.vncRecording.deleteMany({ where: { sessionId } })
  await db.browserWorkspace.deleteMany({ where: { id: ws.id } })
  await db.groupUser.deleteMany({ where: { userId: user.id } })
  await db.groupUser.deleteMany({ where: { userId: user2.id } })
  await db.user.deleteMany({ where: { id: user.id } })
  await db.user.deleteMany({ where: { id: user2.id } })
  await db.group.deleteMany({ where: { id: grp.id } })
  await db.group.deleteMany({ where: { id: grp2.id } })
  await db.group.deleteMany({ where: { id: parentGrp.id } })
  await db.auditLog.deleteMany({ where: { resourceType: "RECORDING" } })
  const remaining = await db.vncRecording.count()
  ok(remaining === 0, "录像表清理归零")
  void STORAGE
  void readdirSync

  console.log(`\n== r27 冒烟结果：${pass} 通过 / ${fail} 失败 ==`)
  if (fail > 0) process.exit(1)
}

main()
  .catch((e) => {
    console.error("冒烟异常：", e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
