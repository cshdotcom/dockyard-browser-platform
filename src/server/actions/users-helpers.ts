// 用户管理共享内部工具（非 "use server" 普通模块：users.ts 与 batch.ts 共用）
// 从 users.ts 抽出避免 server action 文件间互相导入私有函数

import { db } from "@/lib/db"
import { getConfigBool } from "@/lib/config"

// 运行中浏览器会话检查（删除前置条件）
export async function countRunningWorkspaces(userId: string): Promise<number> {
  return db.browserWorkspace.count({
    where: {
      userId,
      deletedAt: null,
      status: { in: ["RUNNING", "CREATING", "IDLE"] },
    },
  })
}

// 撤销用户全部登录会话 + 刷新令牌（强制下线）
export async function kickAllSessions(userId: string, reason: string) {
  const now = new Date()
  const sessions = await db.loginSession.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  })
  await db.loginSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  })
  await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  })
  return sessions.length
}

// 安全变更联动：按配置批量软删 ApiToken
export async function invalidateApiTokensIfConfigured(userId: string): Promise<number> {
  const enabled = await getConfigBool("security.autoInvalidateTokensOnSecurityChange", false)
  if (!enabled) return 0
  const r = await db.apiToken.updateMany({
    where: { userId, deletedAt: null },
    data: { deletedAt: new Date(), enabled: false },
  })
  return r.count
}
