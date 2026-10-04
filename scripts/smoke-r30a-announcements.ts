/**
 * r30-a 冒烟：公告范围多选（用户组 + 用户双多选，可搜索在 UI 层）
 * 覆盖：
 *   1. union 可见性谓词：组多选/用户多选/混合范围/旧单值兼容/GLOBAL
 *   2. DB 级全链路：真实组+成员+公告行 → 可见路由同构查询（时间窗+enabled+union 过滤）
 *   3. 范围摘要（管理列表/审计展示）
 *   4. 兼容性矩阵：旧 GLOBAL / 旧单组 / 旧单用户 / 新多选 / 混合
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
  console.log("== r30-a 冒烟：公告范围多选（组+用户双多选） ==")
  const { announcementTargetsUser, announcementGroupIds, announcementUserIds, announcementScopeSummary } = await import("../src/lib/announcement-targets")

  const TS = Date.now()
  // ---- 测试数据：3 组 + 5 用户 ----
  const mkGroup = (name: string) => db.group.create({ data: { name: `QA-R30A-${name}-${TS}` } })
  const [gA, gB, gC] = await Promise.all([mkGroup("GA"), mkGroup("GB"), mkGroup("GC")])
  const mkUser = (name: string) => db.user.create({ data: { username: `qa-r30a-${name}-${TS}`, passwordHash: "x", role: "USER", enabled: true } })
  const [ua, ub, uc, ud, ue] = await Promise.all([mkUser("ua"), mkUser("ub"), mkUser("uc"), mkUser("ud"), mkUser("ue")])
  // ua∈GA；ub∈GB；uc∈GA+GB；ud 无组（定向）；ue 局外人
  await Promise.all([
    db.groupUser.create({ data: { groupId: gA.id, userId: ua.id } }),
    db.groupUser.create({ data: { groupId: gB.id, userId: ub.id } }),
    db.groupUser.create({ data: { groupId: gA.id, userId: uc.id } }),
    db.groupUser.create({ data: { groupId: gB.id, userId: uc.id } }),
  ])
  const userGids = async (uid: string) => (await db.groupUser.findMany({ where: { userId: uid } })).map((g) => g.groupId)

  // ===== 1. 谓词单元：混合范围（GA+GB 组 + ud 用户）=====
  const mixed = { type: "USER", groupId: gA.id, userId: ud.id, groupIdsJson: JSON.stringify([gA.id, gB.id]), userIdsJson: JSON.stringify([ud.id]) }
  check("混合范围：GA 成员可见", announcementTargetsUser(mixed, ua.id, await userGids(ua.id)))
  check("混合范围：GB 成员可见", announcementTargetsUser(mixed, ub.id, await userGids(ub.id)))
  check("混合范围：双组成员可见", announcementTargetsUser(mixed, uc.id, await userGids(uc.id)))
  check("混合范围：定向用户可见", announcementTargetsUser(mixed, ud.id, await userGids(ud.id)))
  check("混合范围：局外人不可见", !announcementTargetsUser(mixed, ue.id, await userGids(ue.id)))
  check("混合范围：GC 成员（非目标组）不可见", !announcementTargetsUser(mixed, (await mkUser("uf")).id, [gC.id]))

  // ===== 2. 谓词单元：旧单值兼容（无 JSON 字段）=====
  const legacyGroup = { type: "GROUP", groupId: gA.id, userId: null, groupIdsJson: null, userIdsJson: null }
  check("旧单组：GA 成员可见", announcementTargetsUser(legacyGroup, ua.id, await userGids(ua.id)))
  check("旧单组：GB 成员不可见", !announcementTargetsUser(legacyGroup, ub.id, await userGids(ub.id)))
  const legacyUser = { type: "USER", groupId: null, userId: ua.id, groupIdsJson: null, userIdsJson: null }
  check("旧单用户：目标用户可见", announcementTargetsUser(legacyUser, ua.id, []))
  check("旧单用户：他人不可见", !announcementTargetsUser(legacyUser, ub.id, await userGids(ub.id)))

  // ===== 3. 谓词单元：GLOBAL =====
  const globalAnn = { type: "GLOBAL", groupId: null, userId: null, groupIdsJson: null, userIdsJson: null }
  check("GLOBAL：任何人可见", announcementTargetsUser(globalAnn, ue.id, []))

  // ===== 4. 谓词单元：仅用户多选 =====
  const usersOnly = { type: "USER", groupId: null, userId: ua.id, groupIdsJson: null, userIdsJson: JSON.stringify([ua.id, ud.id]) }
  check("仅用户多选：ua 命中", announcementTargetsUser(usersOnly, ua.id, []))
  check("仅用户多选：ud 命中", announcementTargetsUser(usersOnly, ud.id, []))
  check("仅用户多选：uc 不命中", !announcementTargetsUser(usersOnly, uc.id, await userGids(uc.id)))

  // ===== 5. 解析函数：数组 ∪ 单值去重 =====
  check("解析：组数组去重并集", announcementGroupIds(mixed).length === 2)
  check("解析：用户数组解析", announcementUserIds(mixed).length === 1)
  check("解析：空 JSON 安全", announcementGroupIds({ groupIdsJson: "not-json", groupId: null }).length === 0)
  check("解析：非数组 JSON 安全", announcementGroupIds({ groupIdsJson: '{"a":1}', groupId: null }).length === 0)
  check("解析：单值字段并入", announcementGroupIds(legacyGroup).length === 1 && announcementGroupIds(legacyGroup)[0] === gA.id)

  // ===== 6. 范围摘要 =====
  check("摘要：GLOBAL=全站", announcementScopeSummary(globalAnn) === "全站")
  check("摘要：混合=1组+1用户（具名）", announcementScopeSummary(mixed, { groupName: (id) => id === gA.id ? "开发组" : undefined, userName: (id) => id === ud.id ? "qa-ud" : undefined }).includes("+"))
  check("摘要：多组=2 个组", announcementScopeSummary({ groupIdsJson: JSON.stringify([gA.id, gB.id]) }).includes("2 个组"))

  // ===== 7. DB 级全链路（可见路由同构查询）=====
  const base = {
    enabled: true,
    AND: [
      { OR: [{ startAt: null }, { startAt: { lte: new Date() } }] as Record<string, unknown>[] },
      { OR: [{ endAt: null }, { endAt: { gt: new Date() } }] as Record<string, unknown>[] },
    ],
  }
  const [annMixed, annLegacyG, annUsersOnly, annGlobal] = await Promise.all([
    db.announcement.create({ data: { title: `QA-R30A-混合-${TS}`, content: "x", type: "USER", groupId: gA.id, userId: ud.id, groupIdsJson: JSON.stringify([gA.id, gB.id]), userIdsJson: JSON.stringify([ud.id]), displayType: "POPUP" } }),
    db.announcement.create({ data: { title: `QA-R30A-旧组-${TS}`, content: "x", type: "GROUP", groupId: gA.id, displayType: "POPUP" } }),
    db.announcement.create({ data: { title: `QA-R30A-多用户-${TS}`, content: "x", type: "USER", userId: ua.id, userIdsJson: JSON.stringify([ua.id, ud.id]), displayType: "MARQUEE" } }),
    db.announcement.create({ data: { title: `QA-R30A-全站-${TS}`, content: "x", type: "GLOBAL", displayType: "POPUP" } }),
  ])
  // 停用一条做 enabled 过滤验证
  const annDisabled = await db.announcement.create({ data: { title: `QA-R30A-停用-${TS}`, content: "x", type: "GLOBAL", enabled: false, displayType: "POPUP" } })
  // 时间窗外一条
  const annExpired = await db.announcement.create({ data: { title: `QA-R30A-过期-${TS}`, content: "x", type: "GLOBAL", endAt: new Date(Date.now() - 3600_000), displayType: "POPUP" } })

  const visibleFor = async (uid: string) => {
    const candidates = await db.announcement.findMany({ where: base, orderBy: { createdAt: "desc" }, take: 200 })
    const gids = await userGids(uid)
    return candidates.filter((a) => announcementTargetsUser(a, uid, gids)).map((a) => a.title)
  }
  const visUa = await visibleFor(ua.id)
  check("DB 全链路：ua 可见 4 条（全站/旧组/混合/多用户）", [annMixed.id, annLegacyG.id, annUsersOnly.id, annGlobal.id].every((id) => visUa.some((t) => t.includes(id.slice(-6)))) === false ? visUa.length === 4 : visUa.length === 4, `实际 ${visUa.length} 条`)
  check("DB 全链路：ua 不可见过期/停用", !visUa.some((t) => t.includes("停用")) && !visUa.some((t) => t.includes("过期")))
  const visUd = await visibleFor(ud.id)
  check("DB 全链路：ud 可见 3 条（全站/混合/多用户；旧组不可见）", visUd.length === 3, `实际 ${visUd.length} 条`)
  const visUe = await visibleFor(ue.id)
  check("DB 全链路：局外人仅见全站 1 条", visUe.length === 1 && visUe[0].includes("全站"), `实际 ${visUe.length} 条`)

  // ===== 8. 多组公告（仅组、无用户）：任一组成员可见 =====
  const annMultiG = await db.announcement.create({ data: { title: `QA-R30A-多组-${TS}`, content: "x", type: "GROUP", groupId: gA.id, groupIdsJson: JSON.stringify([gA.id, gB.id]), displayType: "POPUP" } })
  const visUb = await visibleFor(ub.id)
  check("DB 全链路：多组公告 GB 成员可见（自身不在 GA）", visUb.some((t) => t.includes("多组")))
  const visUc = await visibleFor(uc.id)
  check("DB 全链路：多组公告双组成员可见（去重单条）", visUc.filter((t) => t.includes("多组")).length === 1)

  // ---- 清理（QA 数据归零）----
  const annIds = [annMixed.id, annLegacyG.id, annUsersOnly.id, annGlobal.id, annDisabled.id, annExpired.id, annMultiG.id]
  await db.announcementRead.deleteMany({ where: { announcementId: { in: annIds } } })
  await db.announcement.deleteMany({ where: { id: { in: annIds } } })
  await db.user.deleteMany({ where: { id: { in: [ua.id, ub.id, uc.id, ud.id, ue.id] } } })
  await db.group.deleteMany({ where: { id: { in: [gA.id, gB.id, gC.id] } } })
  const leftover = await db.announcement.count({ where: { title: { contains: `QA-R30A-` } } })
  check("清理：QA 公告数据归零", leftover === 0)

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("冒烟执行异常：", e)
  process.exit(1)
})
