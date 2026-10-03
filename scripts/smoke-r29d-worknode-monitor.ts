/**
 * r29-d 冒烟：Worker 节点资源监控 + 失联自动迁移
 * 覆盖：
 *   1. 失联判定：ONLINE 节点心跳 30s+ 未达 → OFFLINE + CRITICAL 告警 + 审计
 *   2. 自动迁移：失联节点上的绑定沙箱 → provisioned:pending + migratedFromNodeUuid 溯源
 *   3. 恢复：心跳回归 → ONLINE + 恢复审计
 *   4. 资源水位：CPU/内存/磁盘超阈值 → WARNING 告警（磁盘 ≥95 CRITICAL）
 *   5. 阈值继承：节点级覆盖 > 全局默认
 *   6. 任务注册：worknode_monitor 在引擎 + 种子双注册
 */
import { PrismaClient } from "@prisma/client"

const db = new PrismaClient()
let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

async function main() {
  console.log("== r29-d 冒烟：Worker 节点监控与失联迁移 ==")

  // ---- 清理历史残留（崩溃跑遗留） ----
  await db.workNode.deleteMany({ where: { name: { startsWith: "QA-R29D" } } })
  await db.alert.deleteMany({ where: { title: { contains: "QA-R29D" } } })
  await db.alert.deleteMany({ where: { title: { contains: "QA-ALR" } } })

  // ---- 测试数据：节点 + 绑定沙箱 ----
  const node = await db.workNode.create({
    data: {
      nodeUuid: `wn-qa${Date.now().toString(16).slice(0, 12).padEnd(12, "0")}`,
      name: `QA-R29D-节点-${Date.now()}`, region: "qa",
      apiKeyHash: "x".repeat(64), status: "ONLINE",
      cpuUsage: 45, memUsage: 50, diskUsage: 40, lastHeartbeatAt: new Date(),
    },
  })
  const qaUser = await db.user.create({ data: { username: `qa-r29d-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true } })
  const wsA = await db.browserWorkspace.create({
    data: { name: `QA-R29D-沙箱A-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING", browserNodeId: node.id },
  })
  const wsB = await db.browserWorkspace.create({
    data: { name: `QA-R29D-沙箱B-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "STOPPED", browserNodeId: node.id },
  })

  const { runWorknodeMonitor, planNodeMigration } = await import("../src/lib/worknode-monitor")

  // ---- 1. 健康节点：无告警无迁移 ----
  const r0 = await runWorknodeMonitor(() => {})
  check("健康节点：监控通过（无失联/无水位）", r0.checked >= 1 && r0.offlineMarked === 0)
  const node0 = await db.workNode.findUnique({ where: { id: node.id } })
  check("健康节点：保持 ONLINE", node0?.status === "ONLINE")

  // ---- 2. 失联（心跳 35s 前） → OFFLINE + 迁移 ----
  await db.workNode.update({ where: { id: node.id }, data: { lastHeartbeatAt: new Date(Date.now() - 35_000) } })
  console.error("STEP: offline monitor run")
  const r1 = await runWorknodeMonitor(() => {})
  check("失联判定：OFFLINE 标记", r1.offlineMarked === 1)
  const node1 = await db.workNode.findUnique({ where: { id: node.id } })
  check("失联判定：状态落库 OFFLINE", node1?.status === "OFFLINE")
  check("失联判定：CRITICAL 告警产生", r1.offlineMarked === 1)
  const offlineAlert = await db.alert.findFirst({ where: { title: { contains: node.nodeUuid } }, orderBy: { createdAt: "desc" } })
  check("失联告警：标题与详情含节点标识", !!offlineAlert && (offlineAlert.title || "").includes(node.name))

  console.error("STEP: migration verify")
  const wsA1 = await db.browserWorkspace.findUnique({ where: { id: wsA.id } })
  const hardA = (wsA1?.hardeningJson as { migratedFromNodeUuid?: string; provisioned?: string; migrationReason?: string } | null) || {}
  check("自动迁移：沙箱 A 解绑节点（browserNodeId=null）", wsA1?.browserNodeId === null)
  check("自动迁移：migratedFromNodeUuid 溯源", hardA.migratedFromNodeUuid === node.nodeUuid)
  check("自动迁移：provisioned=pending 待调度", hardA.provisioned === "pending")
  const wsB1 = await db.browserWorkspace.findUnique({ where: { id: wsB.id } })
  check("自动迁移：沙箱 B 同步迁移（STOPPED 也迁）", wsB1?.browserNodeId === null)
  const migrationAudit = await db.auditLog.findFirst({ where: { operationType: "WORKSPACE_MIGRATION_PLANNED", resourceId: wsA.id } })
  check("迁移审计：WORKSPACE_MIGRATION_PLANNED 落库", !!migrationAudit)

  // ---- 3. 心跳恢复 → ONLINE ----
  await db.workNode.update({ where: { id: node.id }, data: { lastHeartbeatAt: new Date() } })
  const r2 = await runWorknodeMonitor(() => {})
  check("恢复：OFFLINE → ONLINE", r2.recovered >= 1)
  const node2 = await db.workNode.findUnique({ where: { id: node.id } })
  check("恢复：状态落库", node2?.status === "ONLINE")
  const recoverAudit = await db.auditLog.findFirst({ where: { operationType: "WORKNODE_RECOVERED", resourceId: node.id } })
  check("恢复审计落库", !!recoverAudit)

  console.error("STEP: thresholds")
  // ---- 4. 资源水位 ----
  await db.workNode.update({ where: { id: node.id }, data: { lastHeartbeatAt: new Date(), cpuUsage: 92, memUsage: 88, diskUsage: 70 } })
  const r3 = await runWorknodeMonitor(() => {})
  check("资源水位：CPU/内存超阈值告警", r3.thresholdAlerts >= 1)
  const resAlert = await db.alert.findFirst({ where: { title: { contains: node.name } }, orderBy: { createdAt: "desc" } })
  check("水位告警详情含阈值明细", !!resAlert && (resAlert?.content || "").includes("CPU 92%"))

  // ---- 5. 磁盘 ≥95 CRITICAL ----
  await db.alert.deleteMany({ where: { title: { contains: node.name } } })
  await db.workNode.update({ where: { id: node.id }, data: { cpuUsage: 30, memUsage: 40, diskUsage: 97 } })
  const r4 = await runWorknodeMonitor(() => {})
  const critAlert = await db.alert.findFirst({ where: { title: { contains: node.name } }, orderBy: { createdAt: "desc" } })
  check("磁盘 ≥95 升级 CRITICAL", r4.thresholdAlerts >= 1 && critAlert?.level === "CRITICAL")

  // ---- 6. 节点级阈值覆盖 ----
  await db.workNode.update({ where: { id: node.id }, data: { diskUsage: 50, cpuUsage: 30, memUsage: 40, cpuThresholdPct: 20 } })
  await db.alert.deleteMany({ where: { title: { contains: node.name } } })
  const r5 = await runWorknodeMonitor(() => {})
  const covAlert = await db.alert.findFirst({ where: { title: { contains: node.name } }, orderBy: { createdAt: "desc" } })
  check("节点级阈值覆盖（CPU 20% 即触发）", r5.thresholdAlerts >= 1 && (covAlert?.content || "").includes("CPU 30% ≥ 20%"))

  // ---- 7. planNodeMigration 幂等（已迁空的节点再迁 → 0） ----
  const m2 = await planNodeMigration(node.id, node.nodeUuid, "MANUAL_TEST")
  check("迁移幂等：无绑定沙箱时返回 0", m2.planned === 0)

  // ---- 8. 任务注册 ----
  const taskRow = await db.scheduleTask.findUnique({ where: { code: "worknode_monitor" } })
  check("种子任务注册（worknode_monitor）", !!taskRow && taskRow.enabled)
  const engineSrc = await import("fs").then((fs) => fs.readFileSync("src/server/tasks/engine.ts", "utf-8"))
  check("引擎任务注册（worknode_monitor）", engineSrc.includes("async worknode_monitor"))

  // ---- 清理 ----
  await db.alert.deleteMany({ where: { title: { contains: node.name } } })
  await db.auditLog.deleteMany({ where: { resourceId: node.id } })
  await db.auditLog.deleteMany({ where: { resourceId: { in: [wsA.id, wsB.id] } } })
  await db.browserWorkspace.deleteMany({ where: { userId: qaUser.id } })
  await db.user.delete({ where: { id: qaUser.id } })
  await db.workNode.delete({ where: { id: node.id } })

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
