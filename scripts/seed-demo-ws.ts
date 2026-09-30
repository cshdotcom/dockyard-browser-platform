// 演示数据补种：多形态工作区（跨用户/双模式/不同时长/代理出口/软删记录）供管理列表增强验证
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "crypto"
const db = new PrismaClient()
async function main() {
  const admin = await db.user.findUnique({ where: { username: "admin" } })
  const demo = await db.user.findUnique({ where: { username: "demo" } })
  if (!admin || !demo) { console.log("缺少 admin/demo 用户，先跑 seed"); return }
  const existing = await db.browserWorkspace.count()
  if (existing >= 6) { console.log(`已有 ${existing} 个工作区，跳过补种`); return }

  const proxy = await db.proxyNode.findFirst({ where: { deletedAt: null } })
  const now = Date.now()
  const mk = (data: Record<string, unknown>) => ({ ...data })

  // 1. admin 的 CDP 工作区 · 运行 3.2 小时 · 活跃 2 分钟前
  await db.browserWorkspace.create({ data: mk({
    name: "CDP 采集-新闻监控", mode: "cdp_light", status: "RUNNING", userId: admin.id, createdByUserId: admin.id,
    proxyNodeId: proxy?.id || null, steelSessionId: "sim-steel-1", cdpUrl: "ws://sim/1",
    startedAt: new Date(now - 3.2 * 3600_000), runtimeAccumSec: 5 * 3600, lastActiveAt: new Date(now - 2 * 60_000),
    ttlMinutes: 0, idleTimeoutMinutes: 120, cdpCallCount: 142, createdAt: new Date(now - 26 * 3600_000),
  }) })
  // 2. demo 的 NoVNC 工作区 · 运行 12 分钟（无累计）
  await db.browserWorkspace.create({ data: mk({
    name: "NoVNC 桌面-运营后台", mode: "novnc_full", status: "RUNNING", userId: demo.id, createdByUserId: demo.id,
    novncSessionId: "sim-novnc-1", novncConnCount: 2, containerRef: "",
    startedAt: new Date(now - 12 * 60_000), lastActiveAt: new Date(now - 30_000),
    networkPolicyJson: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", domainMode: "blacklist", domainBlack: 3, domainWhite: 0 },
    ttlMinutes: 240, idleTimeoutMinutes: 60, cdpCallCount: 0, createdAt: new Date(now - 2 * 3600_000),
  }) })
  // 3. demo 创建后转移给 admin（归属≠创建人徽章）
  await db.browserWorkspace.create({ data: mk({
    name: "NoVNC 会话-电商比价（已转移）", mode: "novnc_full", status: "IDLE", userId: admin.id, createdByUserId: demo.id,
    novncSessionId: "sim-novnc-2", containerRef: "",
    startedAt: new Date(now - 8 * 3600_000), runtimeAccumSec: 30 * 3600, lastActiveAt: new Date(now - 40 * 60_000),
    networkPolicyJson: { allowInternalNetwork: true, allowSecureLocationAccess: false, source: "USER_OVERRIDE", domainMode: "whitelist", domainWhite: 4, endpointBlack: 2 },
    ttlMinutes: 0, idleTimeoutMinutes: 90, novncConnCount: 0, createdAt: new Date(now - 3 * 86400_000),
  }) })
  // 4. 已停止的 CDP（累计 8 小时冻结）
  await db.browserWorkspace.create({ data: mk({
    name: "CDP 脚本-夜间巡检（已停止）", mode: "cdp_light", status: "STOPPED", userId: demo.id, createdByUserId: demo.id,
    runtimeAccumSec: 8 * 3600, lastActiveAt: new Date(now - 9 * 3600_000),
    ttlMinutes: 0, idleTimeoutMinutes: 60, cdpCallCount: 86, createdAt: new Date(now - 5 * 86400_000),
  }) })
  // 5. 错误状态
  await db.browserWorkspace.create({ data: mk({
    name: "NoVNC 桌面-异常示例", mode: "novnc_full", status: "ERROR", userId: demo.id, createdByUserId: demo.id,
    crashCategory: "CONTAINER_EXITED", containerRef: "dockyard-ws-demo-err",
    runtimeAccumSec: 2 * 3600, lastActiveAt: new Date(now - 2 * 3600_000),
    ttlMinutes: 0, idleTimeoutMinutes: 60, createdAt: new Date(now - 6 * 86400_000),
  }) })
  // 6. 软删 + 回收站记录（删除来源：管理员）
  const del = await db.browserWorkspace.create({ data: mk({
    name: "NoVNC 桌面-已删除样例", mode: "novnc_full", status: "STOPPED", userId: demo.id, createdByUserId: demo.id,
    runtimeAccumSec: 1.5 * 3600, createdAt: new Date(now - 8 * 86400_000),
    deletedAt: new Date(now - 1 * 86400_000),
  }) })
  await db.recycleBin.create({ data: {
    resourceType: "WORKSPACE", resourceId: del.id, resourceName: del.name,
    ownerUserId: demo.id, createdByUserId: demo.id, deletedByUserId: admin.id, deletedByType: "ADMIN",
    reason: "管理员强制移入回收站（原状态 ERROR）", originalSnapshot: JSON.stringify({ id: del.id, name: del.name }),
  } })
  console.log("补种完成：6 个演示工作区（含跨用户/转移/软删）")
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
