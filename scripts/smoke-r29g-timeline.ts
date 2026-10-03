/**
 * r29-g 冒烟：行为监控时间轴（四源统一）
 * 覆盖：浏览/文件/网络/系统四源采集 + 倒序合并 + 时间窗口 + 关键词过滤 + 计数
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
  console.log("== r29-g 冒烟：行为监控时间轴 ==")
  const { buildBehaviorTimeline } = await import("../src/lib/behavior-timeline")
  const getBehaviorTimelineAction = (input: { workspaceId: string; fromMin?: number; keyword?: string }) => buildBehaviorTimeline(input).then((data) => ({ code: 0, data })) as Promise<{ code: number; data: Awaited<ReturnType<typeof buildBehaviorTimeline>> }>

  const qaUser = await db.user.create({ data: { username: `qa-r29g-${Date.now()}`, passwordHash: "x", role: "USER", enabled: true } })
  const qaWs = await db.browserWorkspace.create({ data: { name: `QA-R29G-WS-${Date.now()}`, userId: qaUser.id, mode: "novnc_full", status: "RUNNING" } })

  // 四源数据构造
  await db.browseHistoryEntry.create({ data: { workspaceId: qaWs.id, workspaceUuid: "u1", userId: qaUser.id, url: "https://example.com/page", title: "示例页", domain: "example.com", visitAt: new Date(Date.now() - 60_000), dwellMs: 45_000 } })
  await db.browseHistoryEntry.create({ data: { workspaceId: qaWs.id, workspaceUuid: "u1", userId: qaUser.id, url: "https://shop.test/cart", title: "购物车", domain: "shop.test", visitAt: new Date(Date.now() - 120_000), dwellMs: 12_000 } })
  await db.auditLog.create({ data: { operatorUserId: "sys", operatorName: "系统", operationType: "FILE_DOWNLOAD", resourceType: "WORKSPACE", resourceId: qaWs.id, afterJson: JSON.stringify({ path: "/downloads/a.pdf" }), severity: "INFO" } })
  await db.auditLog.create({ data: { operatorUserId: "sys", operatorName: "系统", operationType: "WS_POLICY_REFRESH", resourceType: "WORKSPACE", resourceId: qaWs.id, afterJson: "{}", severity: "WARN" } })
  await db.harRecord.create({ data: { workspaceId: qaWs.id, userId: qaUser.id, harJson: "{}", sizeBytes: 2048 } })

  // 全量时间轴（24h 窗口）
  const r = await getBehaviorTimelineAction({ workspaceId: qaWs.id, fromMin: 1440 })
  check("时间轴：调用成功", r.code === 0 && !!r.data)
  const ev = r.data!.events
  check("时间轴：四源全部命中", r.data!.counts.browse === 2 && r.data!.counts.file === 1 && r.data!.counts.system >= 1 && r.data!.counts.network === 1)
  check("时间轴：事件总数 ≥ 5", ev.length >= 5, `实际 ${ev.length}`)
  check("时间轴：倒序排列", ev.every((e, i) => i === 0 || ev[i - 1].ts >= e.ts))

  const kinds = new Set(ev.map((e) => e.kind))
  check("时间轴：kind 四类分布", (["browse", "file", "network", "system"] as const).every((k) => kinds.has(k)))
  const browseEv = ev.find((e) => e.kind === "browse")
  check("时间轴：浏览事件含停留时长", !!browseEv && String(browseEv.detail || "").includes("停留"))

  // 关键词过滤
  const rk = await getBehaviorTimelineAction({ workspaceId: qaWs.id, fromMin: 1440, keyword: "shop.test" })
  check("时间轴：关键词过滤命中（浏览源过滤至 1）", rk.code === 0 && rk.data!.events.filter((e) => e.kind === "browse").length === 1)

  // 窗口过滤（5 分钟前的事件不可见）
  await db.browseHistoryEntry.updateMany({ where: { workspaceId: qaWs.id, domain: "example.com" }, data: { visitAt: new Date(Date.now() - 2 * 86400_000) } })
  const rw = await getBehaviorTimelineAction({ workspaceId: qaWs.id, fromMin: 1440 })
  check("时间轴：时间窗口过滤（24h 外不可见）", rw.code === 0 && rw.data!.counts.browse === 1)

  // ---- 清理 ----
  await db.browseHistoryEntry.deleteMany({ where: { workspaceId: qaWs.id } })
  await db.harRecord.deleteMany({ where: { workspaceId: qaWs.id } })
  await db.auditLog.deleteMany({ where: { resourceId: qaWs.id } })
  await db.browserWorkspace.delete({ where: { id: qaWs.id } })
  await db.user.delete({ where: { id: qaUser.id } })

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
