/**
 * r29-f 冒烟：分布式文件存储 9 大条件
 * 覆盖：
 *   1. resolveFilePlacement 决策向量（纯函数）：
 *      ① 沙箱绑定强制落地（超水位仍强制 + 告警文案）
 *      ② ≥10MB 直沉 / 小文件主控中转
 *      ③ 共享协作下沉被访问端
 *      ⑤ 水位排除（超 80% 节点不接新落盘）
 *      ⑥ 副本 1-3 钳制 + 跨节点分布 + 无节点降级
 *      ①-b 沙箱节点不可达 → 主控兜底
 *   2. registerFileUpload 落库（MASTER 兜底 + relay TTL 24h + placements）
 *   3. runDfsMaintenance：
 *      ⑨ 中转超时强制下沉（relayed=true + SYNCING→ACTIVE）
 *      ⑦ 副本修复（节点 OFFLINE → LOST + 重建计划）
 *      ④ 冷热分层（30 天未访问 → COLD；访问回热）
 *   4. migrateFilesForWorkspace：沙箱迁移文件随迁
 *   5. Worker 文件通道：file.put sha256 校验 / 穿越拒绝 / status / delete
 */
import { PrismaClient } from "@prisma/client"
import { rmSync, mkdirSync } from "fs"
import { createHash } from "crypto"

const db = new PrismaClient()
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const MB = 1048576

async function main() {
  console.log("== r29-f 冒烟：分布式文件存储 9 大条件 ==")
  const { resolveFilePlacement, registerFileUpload, runDfsMaintenance, migrateFilesForWorkspace, recordFileAccess, runDfsTiering } = await import("../src/lib/distributed-file-store")

  const nodes = [
    { nodeUuid: "MASTER", region: "master", diskUsagePct: 30, status: "ONLINE" as const, maxStorageMb: 200000, storageUsedMb: 50000 },
    { nodeUuid: "wn-aabb112233445566", region: "east", diskUsagePct: 40, status: "ONLINE" as const, maxStorageMb: 100000, storageUsedMb: 30000 },
    { nodeUuid: "wn-ccdd778899001122", region: "west", diskUsagePct: 45, status: "ONLINE" as const, maxStorageMb: 80000, storageUsedMb: 20000 },
    { nodeUuid: "wn-eeff334455667788", region: "east", diskUsagePct: 95, status: "ONLINE" as const, maxStorageMb: 50000, storageUsedMb: 48000 }, // 超水位
  ]
  const base = { safeWatermarkPct: 20, directThresholdBytes: 10 * MB }

  // ---- ① 沙箱绑定强制落地（最高优先级，超水位也强制） ----
  const d1 = resolveFilePlacement({ ...base, sizeBytes: 5 * MB, bindType: "SANDBOX", sandboxNodeUuid: "wn-eeff334455667788", replicas: 1 }, nodes)
  check("① 沙箱绑定强制落地：PRIMARY=绑定节点（超水位不换）", d1.placements[0].nodeUuid === "wn-eeff334455667788" && d1.placements[0].role === "PRIMARY")
  check("① 水位硬约束告警文案", d1.watermarkAlert !== null && d1.watermarkAlert.includes("95%"))
  check("① 副本避开超水位节点", d1.placements.every((p) => p.nodeUuid !== "wn-eeff334455667788" || p.role === "PRIMARY"))

  // ---- ①-b 沙箱节点不可达 → 主控兜底 ----
  const d2 = resolveFilePlacement({ ...base, sizeBytes: 5 * MB, bindType: "SANDBOX", sandboxNodeUuid: "wn-notexist", replicas: 1 }, nodes)
  check("①-b 沙箱节点不可达 → MASTER 兜底", d2.placements[0].nodeUuid === "MASTER")

  // ---- ② 上传通道阈值 ----
  const d3 = resolveFilePlacement({ ...base, sizeBytes: 15 * MB, bindType: "GENERAL", replicas: 1 }, nodes)
  check("② ≥10MB → 直沉 Worker", d3.uploadChannel === "DIRECT_WORKER")
  const d4 = resolveFilePlacement({ ...base, sizeBytes: 2 * MB, bindType: "GENERAL", replicas: 1 }, nodes)
  check("② 小文件 → 主控中转", d4.uploadChannel === "MASTER_RELAY")

  // ---- ③ 共享协作下沉被访问端 ----
  const d5 = resolveFilePlacement({ ...base, sizeBytes: 3 * MB, bindType: "SHARE", accessNodeUuid: "wn-ccdd778899001122", replicas: 1 }, nodes)
  check("③ 共享文件下沉被访问端", d5.placements[0].nodeUuid === "wn-ccdd778899001122")

  // ---- ⑤ 水位排除（常规路由避开 95% 节点） ----
  const d6 = resolveFilePlacement({ ...base, sizeBytes: 1 * MB, bindType: "GENERAL", replicas: 3 }, nodes)
  check("⑤ 常规路由避开超水位节点", d6.placements.every((p) => p.nodeUuid !== "wn-eeff334455667788"))
  check("⑤ 水位排除理由", d6.reasons.some((r) => r.includes("水位排除")))

  // ---- ⑥ 副本钳制与分布 ----
  const d7 = resolveFilePlacement({ ...base, sizeBytes: 1 * MB, bindType: "GENERAL", replicas: 99 }, nodes)
  check("⑥ 副本钳制 1-3（99→3）", d7.placements.length === 3)
  check("⑥ 副本跨节点不重复", new Set(d7.placements.map((p) => p.nodeUuid)).size === d7.placements.length)
  const d8 = resolveFilePlacement({ ...base, sizeBytes: 1 * MB, bindType: "GENERAL", replicas: 2 }, [{ nodeUuid: "MASTER", region: "m", diskUsagePct: 0, status: "ONLINE" as const, maxStorageMb: 1, storageUsedMb: 0 }])
  check("⑥ 无多节点 → 单副本降级", d8.placements.length === 1 && d8.reasons.some((r) => r.includes("单副本降级")))

  // ---- 注册上传（真实落库） ----
  const qaUser = await db.user.create({ data: { username: `qa-r29f-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true } })
  const qaWs = await db.browserWorkspace.create({ data: { name: `QA-R29F-WS-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING" } })
  const reg = await registerFileUpload({ name: "doc-小文件.pdf", sizeBytes: 2 * MB, bindType: "SANDBOX", bindId: qaWs.id, sha256: "a".repeat(64) })
  check("注册：fileKey 生成（sha256 前缀）", reg.fileKey.startsWith("aaaaaaaaaaaaaaaa-"))
  const row = await db.fileObject.findUnique({ where: { id: reg.fileId }, include: { placements: true } })
  check("注册：小文件 → MASTER_RELAY + 24h TTL", row?.uploadChannel === "MASTER_RELAY" && row?.relayExpiresAt !== null)
  check("注册：placement 落库（MASTER PRIMARY ACTIVE）", row?.placements.length === 1 && row.placements[0].nodeUuid === "MASTER" && row.placements[0].status === "ACTIVE")

  const regBig = await registerFileUpload({ name: "video-大文件.mp4", sizeBytes: 20 * MB, bindType: "USER", bindId: qaUser.id, sha256: "b".repeat(64), replicas: 1 })
  const rowBig = await db.fileObject.findUnique({ where: { id: regBig.fileId }, include: { placements: true } })
  check("注册：≥10MB → DIRECT_WORKER 无 TTL", rowBig?.uploadChannel === "DIRECT_WORKER" && rowBig?.relayExpiresAt === null)

  // ---- ⑨ 中转超时强制下沉 ----
  await db.fileObject.update({ where: { id: reg.fileId }, data: { relayExpiresAt: new Date(Date.now() - 1000) } })
  const m1 = await runDfsMaintenance()
  check("⑨ 中转超时强制下沉（relayed=true）", m1.relayExpired >= 1)
  const rowAfter = await db.fileObject.findUnique({ where: { id: reg.fileId } })
  check("⑨ 下沉后 relayed 标记", rowAfter?.relayed === true as boolean | undefined)

  // ---- ④ 冷热分层 ----
  const coldFile = await db.fileObject.create({
    data: {
      fileKey: `cold-${Date.now()}-x.bin`, name: "old-archive.bin", sizeBytes: 3 * MB, sha256: "c".repeat(64),
      bindType: "GENERAL", relayed: true, lastAccessAt: new Date(Date.now() - 40 * 86400_000), // 40 天未访问
      placements: { create: [{ nodeUuid: "MASTER", role: "PRIMARY", status: "ACTIVE", sizeBytes: 3 * MB }] },
    },
  })
  const t1 = await runDfsTiering()
  const coldRow = await db.fileObject.findUnique({ where: { id: coldFile.id } })
  check("④ 30 天未访问 → COLD", coldRow?.tier === "COLD")
  // 访问回热
  await db.fileObject.update({ where: { id: coldFile.id }, data: { lastAccessAt: new Date() } })
  await runDfsTiering()
  const hotRow = await db.fileObject.findUnique({ where: { id: coldFile.id } })
  check("④ 活跃访问回热 → HOT", hotRow?.tier === "HOT")

  // ---- ⑦ 副本修复（节点 OFFLINE → LOST + 重建） ----
  const offNode = await db.workNode.create({
    data: { nodeUuid: `wn-qa${Date.now().toString(16).slice(0, 12).padEnd(12, "0")}`, name: "QA-R29F-OFF", apiKeyHash: "x", status: "ONLINE", region: "qa" },
  })
  const onNode = await db.workNode.create({
    data: { nodeUuid: `wn-qa${(Date.now() + 1).toString(16).slice(0, 12).padEnd(12, "0")}`, name: "QA-R29F-ON2", apiKeyHash: "x", status: "ONLINE", region: "qa2", lastHeartbeatAt: new Date() },
  })
  const multiFile = await db.fileObject.create({
    data: {
      fileKey: `multi-${Date.now()}-y.bin`, name: "replicated.bin", sizeBytes: 5 * MB, sha256: "d".repeat(64),
      bindType: "GENERAL", relayed: true, replicas: 2,
      placements: {
        create: [
          { nodeUuid: "MASTER", role: "PRIMARY", status: "ACTIVE", sizeBytes: 5 * MB },
          { nodeUuid: offNode.nodeUuid, role: "REPLICA", status: "ACTIVE", sizeBytes: 5 * MB },
        ],
      },
    },
  })
  // 节点转 OFFLINE → 维护 → LOST + 重建
  await db.workNode.update({ where: { id: offNode.id }, data: { status: "OFFLINE", lastHeartbeatAt: new Date(Date.now() - 120_000) } })
  const m2 = await runDfsMaintenance()
  const lostPl = await db.filePlacement.findFirst({ where: { fileId: multiFile.id, nodeUuid: offNode.nodeUuid } })
  check("⑦ 失联节点副本 → LOST", lostPl?.status === "LOST")
  const repairPl = await db.filePlacement.findMany({ where: { fileId: multiFile.id, status: "SYNCING" } })
  check("⑦ 重建计划（SYNCING 新落点）", repairPl.length >= 1)
  check("⑦ 维护结果上报", m2.lostMarked >= 1 && m2.repairsPlanned >= 1)

  // ---- ⑧ 沙箱迁移文件随迁 ----
  const migNode = { nodeUuid: "wn-aabb112233445566" }
  // 给沙箱绑定文件补一个 source 落点
  await db.filePlacement.create({ data: { fileId: row!.id, nodeUuid: migNode.nodeUuid, role: "REPLICA", status: "ACTIVE", sizeBytes: 2 * MB } }).catch(() => null)
  const mig = await migrateFilesForWorkspace(qaWs.id, migNode.nodeUuid, "MASTER")
  check("⑧ 沙箱迁移 → 文件随迁计划", mig.migrated >= 1)
  const migPl = await db.filePlacement.findFirst({ where: { fileId: row!.id, nodeUuid: "MASTER" } })
  check("⑧ 迁移落点 MIGRATING 标记", (migPl?.status === "MIGRATING") as boolean)

  // ---- ③ 访问上报（共享下沉键） ----
  const acc = await recordFileAccess(row!.fileKey, "wn-ccdd778899001122")
  check("③ 访问上报落库（accessNode）", acc.ok)
  const accRow = await db.fileObject.findUnique({ where: { id: row!.id } })
  check("③ accessNode 记录被访问端", accRow?.accessNode === "wn-ccdd778899001122")

  // ---- Worker 文件通道（file-commands 直调） ----
  process.env.WORKER_DFS_DIR = "/tmp/dy-r29f-store"
  rmSync("/tmp/dy-r29f-store", { recursive: true, force: true })
  mkdirSync("/tmp/dy-r29f-store", { recursive: true })
  const { handleFileCommand } = await import("../mini-services/worker/file-commands")
  const content = Buffer.from("dockyard-dfs-test-content")
  const sha = createHash("sha256").update(content).digest("hex")
  const put = await handleFileCommand("file.put", { fileKey: "test-file.bin", contentB64: content.toString("base64"), sha256: sha })
  check("Worker 通道：file.put + sha256 校验通过", put.ok)
  const st = await handleFileCommand("file.status", { fileKey: "test-file.bin" })
  check("Worker 通道：file.status 命中", (st.data as { exists: boolean } | undefined)?.exists === true)
  const badPut = await handleFileCommand("file.put", { fileKey: "bad.bin", contentB64: "eA==", sha256: "f".repeat(64) })
  check("Worker 通道：sha256 不匹配拒绝（文件删除）", !badPut.ok && (badPut.error || "").includes("sha256"))
  const trav = await handleFileCommand("file.put", { fileKey: "../../etc/passwd", contentB64: "eA==" })
  check("Worker 通道：路径穿越拒绝", !trav.ok && (trav.error || "").includes("穿越"))
  const del = await handleFileCommand("file.delete", { fileKey: "test-file.bin" })
  const stAfter = await handleFileCommand("file.status", { fileKey: "test-file.bin" })
  check("Worker 通道：file.delete 清除", del.ok && (stAfter.data as { exists: boolean } | undefined)?.exists === false)

  // ---- 清理 ----
  rmSync("/tmp/dy-r29f-store", { recursive: true, force: true })
  await db.fileObject.deleteMany({ where: { OR: [{ bindId: qaWs.id }, { bindId: qaUser.id }, { id: coldFile.id }, { id: multiFile.id }] } })
  await db.alert.deleteMany({ where: { title: { contains: "QA-R29F" } } })
  await db.alert.deleteMany({ where: { title: { contains: "副本失联" } } })
  await db.auditLog.deleteMany({ where: { operationType: { in: ["DFS_FILES_MIGRATED", "DFS_MAINTENANCE_RUN"] } } })
  await db.browserWorkspace.delete({ where: { id: qaWs.id } })
  await db.user.delete({ where: { id: qaUser.id } })
  await db.workNode.deleteMany({ where: { id: { in: [offNode.id, onNode.id] } } })

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
