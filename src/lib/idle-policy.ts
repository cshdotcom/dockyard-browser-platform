import { db } from "@/lib/db"
import { getConfigNumber } from "@/lib/config"
import { userGroupIds } from "@/lib/permissions"

// ============================================================
// r14（22-c）：沙箱闲置超时四级策略链
// 解析优先级（越靠近资源越优先）：
//   1. 沙箱级 BrowserWorkspace.idleTimeoutMinutes（非空 Float，语义=「创建/编辑时锁定的生效值」；
//      与用户→组→全局链解析值不一致时视为沙箱级覆盖/快照偏移）
//   2. 用户级 User.idleTimeoutMinutes（null=继承组，0=无限）
//   3. 用户组级 Group.idleTimeoutMinutes（null=继承全局默认，0=无限；多组取第一个非空组）
//   4. 全局默认 workspace.defaultIdleTimeoutMin（SystemConfig，默认 60，0=无限）
//
// 锁定开关：User.idleTimeoutLocked / Group.idleTimeoutLocked 任一命中（用户级优先）
//   → 普通用户在创建/编辑工作区时不可自行调整闲置超时（表单只读展示「由管理员策略锁定」）；
//   SUPER_ADMIN / ADMIN 不受限（管理员可显式覆盖任意层级）。
//
// 语义统一：0 = 无限（永不闲置回收，与 TTL 0=不限、engine idleExpired `>0 &&` 语义对齐）
// ============================================================

export type IdleSource = "sandbox" | "user" | "group" | "global"

export interface IdleTimeoutResolution {
  /** 生效闲置超时（分钟，0=无限） */
  minutes: number
  /** 生效层级 */
  source: IdleSource
  /** 层级中文标签（详情页徽章/表单提示用） */
  sourceLabel: string
}

const SOURCE_LABELS: Record<IdleSource, string> = {
  sandbox: "沙箱级",
  user: "用户级",
  group: "用户组级",
  global: "全局默认",
}

/** 格式化分钟数（0=无限） */
export function fmtIdleMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—"
  return minutes > 0 ? `${Math.round(minutes)} 分钟` : "无限（不回收）"
}

/** 审计/日志用简短格式 */
export function fmtIdleBrief(minutes: number): string {
  return minutes > 0 ? `${Math.round(minutes)}分钟` : "无限"
}

/** 序列化视图（Server Action 返回给客户端表单回显/提示用） */
export interface IdlePolicyView {
  defaultMinutes: number
  defaultSource: IdleSource
  defaultSourceLabel: string
  locked: boolean
  lockSourceLabel: string
  userMinutes: number | null
  groupMinutes: number | null
  globalDefault: number
}

export function toIdlePolicyView(p: IdlePolicyForUser): IdlePolicyView {
  return {
    defaultMinutes: p.defaultMinutes,
    defaultSource: p.defaultSource,
    defaultSourceLabel: p.defaultSourceLabel,
    locked: p.locked,
    lockSourceLabel: p.lockSourceLabel,
    userMinutes: p.userMinutes,
    groupMinutes: p.groupMinutes,
    globalDefault: p.globalDefault,
  }
}

/**
 * 纯函数四级解析（无 DB 访问；server action / 页面展示 / 测试共用）
 * - ws.idleTimeoutMinutes 非空且 ≠ 链解析值 → 沙箱级覆盖（生效值取沙箱值）
 * - 否则 用户级(非null) > 组级(非null) > 全局默认
 */
export function resolveIdleTimeout(
  ws: { idleTimeoutMinutes?: number | null } | null | undefined,
  user: { idleTimeoutMinutes?: number | null } | null | undefined,
  group: { idleTimeoutMinutes?: number | null } | null | undefined,
  globalDefault: number,
): IdleTimeoutResolution {
  const userVal = user?.idleTimeoutMinutes ?? null
  const groupVal = group?.idleTimeoutMinutes ?? null
  const chainVal = userVal != null ? userVal : groupVal != null ? groupVal : globalDefault
  const chainSource: IdleSource = userVal != null ? "user" : groupVal != null ? "group" : "global"

  const wsVal = ws?.idleTimeoutMinutes ?? null
  if (wsVal != null && wsVal !== chainVal) {
    // 沙箱持有的锁定值与当前策略链不一致：视为沙箱级覆盖（含管理员显式覆写/策略后置偏移快照）
    return { minutes: wsVal, source: "sandbox", sourceLabel: SOURCE_LABELS.sandbox }
  }
  return { minutes: chainVal, source: chainSource, sourceLabel: SOURCE_LABELS[chainSource] }
}

/** 锁定层级（用户级优先于组级） */
export type IdleLockSource = "user" | "group" | null

export interface IdlePolicyForUser {
  /** 用户创建工作区时的默认闲置超时（分钟，0=无限）——用户级(非null)→组级(非null)→全局默认 */
  defaultMinutes: number
  defaultSource: IdleSource
  defaultSourceLabel: string
  /** 是否被管理员锁定（普通用户创建/编辑表单只读） */
  locked: boolean
  lockSource: IdleLockSource
  lockSourceLabel: string
  /** 原始层级值（诊断/表单回显） */
  userMinutes: number | null
  groupMinutes: number | null
  globalDefault: number
}

/** 管理员角色豁免锁定（共享管控同语义：约束的是普通用户的自行调整行为） */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN"
}

/**
 * 用户维度闲置超时策略解析（含锁定开关）
 * @param userId 目标用户 id
 * @param role   目标用户角色（管理员 → locked=false 豁免）
 */
export async function resolveIdlePolicyForUser(userId: string, role?: string | null): Promise<IdlePolicyForUser> {
  const [user, gids] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { idleTimeoutMinutes: true, idleTimeoutLocked: true } }),
    userGroupIds(userId),
  ])
  const globalDefault = await getConfigNumber("workspace.defaultIdleTimeoutMin", 60)

  // 多组：按组创建顺序取第一个非空 idleTimeoutMinutes 的组（值链）；锁定链同理（用户级优先）
  let groupMinutes: number | null = null
  let groupLocked = false
  let groupLockName = ""
  if (gids.length) {
    const groups = await db.group.findMany({
      where: { id: { in: gids }, deletedAt: null },
      select: { id: true, name: true, idleTimeoutMinutes: true, idleTimeoutLocked: true },
      orderBy: { createdAt: "asc" },
    })
    for (const g of groups) {
      if (groupMinutes == null && g.idleTimeoutMinutes != null) groupMinutes = g.idleTimeoutMinutes
      if (!groupLocked && g.idleTimeoutLocked) {
        groupLocked = true
        groupLockName = g.name
      }
    }
  }

  const userMinutes = user?.idleTimeoutMinutes ?? null
  const userLocked = user?.idleTimeoutLocked === true

  const lockSource: IdleLockSource = userLocked ? "user" : groupLocked ? "group" : null
  // 管理员豁免：锁定约束的是普通用户
  const locked = !isAdminRole(role) && lockSource != null
  const defaultMinutes = userMinutes != null ? userMinutes : groupMinutes != null ? groupMinutes : globalDefault
  const defaultSource: IdleSource = userMinutes != null ? "user" : groupMinutes != null ? "group" : "global"

  return {
    defaultMinutes,
    defaultSource,
    defaultSourceLabel: SOURCE_LABELS[defaultSource],
    locked,
    lockSource,
    lockSourceLabel:
      lockSource === "user"
        ? "用户级锁定"
        : lockSource === "group"
          ? `用户组级锁定${groupLockName ? `（${groupLockName}）` : ""}`
          : "未锁定",
    userMinutes,
    groupMinutes,
    globalDefault,
  }
}

export interface IdlePolicyForWorkspace {
  /** 工作区当前生效值与来源（四级徽章展示） */
  resolution: IdleTimeoutResolution
  /** 所有者策略（锁定态供编辑表单判断） */
  ownerPolicy: IdlePolicyForUser
  wsMinutes: number
}

/** 工作区维度解析：沙箱锁定值 vs 所有者策略链（详情页「生效值+来源」展示） */
export async function resolveIdlePolicyForWorkspace(workspaceId: string): Promise<IdlePolicyForWorkspace | null> {
  const ws = await db.browserWorkspace.findUnique({
    where: { id: workspaceId },
    select: { idleTimeoutMinutes: true, userId: true },
  })
  if (!ws) return null

  const ownerPolicy = await resolveIdlePolicyForUser(ws.userId)

  // 工作区持有值与所有者链解析：不一致 → 沙箱级覆盖
  const chainVal = ownerPolicy.defaultMinutes
  const chainSource: IdleSource = ownerPolicy.defaultSource
  const resolution: IdleTimeoutResolution =
    ws.idleTimeoutMinutes != null && ws.idleTimeoutMinutes !== chainVal
      ? { minutes: ws.idleTimeoutMinutes, source: "sandbox", sourceLabel: SOURCE_LABELS.sandbox }
      : { minutes: chainVal, source: chainSource, sourceLabel: SOURCE_LABELS[chainSource] }

  return { resolution, ownerPolicy, wsMinutes: ws.idleTimeoutMinutes ?? chainVal }
}
