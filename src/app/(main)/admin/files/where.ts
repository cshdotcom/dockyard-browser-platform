// 管理端文件列表筛选条件构建（服务端/导出路由共用；无客户端指令）
//
// 语义（r28a）：
//   · node 缺省       → 默认主节点（storageNodeId = null）
//   · node=master     → 主节点
//   · node=__all__    → 全部节点（不过滤）
//   · node=id1,id2    → 指定节点集合
//   · node=master,id  → 主节点 + 指定节点（OR 组合）
import type { Prisma } from "@prisma/client"

export interface FilesFilterWhere {
  category?: string
  userId?: string
  keyword?: string
  node?: string
}

export function buildFilesWhere(f: FilesFilterWhere): Prisma.FileMetaWhereInput {
  const conditions: Prisma.FileMetaWhereInput[] = [{ deletedAt: null }]
  if (f.category) conditions.push({ category: f.category })
  if (f.userId) conditions.push({ userId: f.userId })
  if (f.keyword) {
    conditions.push({ OR: [{ fileName: { contains: f.keyword } }, { storageKey: { contains: f.keyword } }] })
  }

  const nodeParam = (f.node || "").trim()
  if (!nodeParam || nodeParam === "master") {
    // 默认主节点：storageNodeId 为空
    conditions.push({ storageNodeId: null })
  } else if (nodeParam !== "__all__") {
    const parts = nodeParam.split(",").map((s) => s.trim()).filter(Boolean)
    const hasMaster = parts.includes("master")
    const ids = parts.filter((p) => p !== "master" && p !== "__all__")
    if (hasMaster && ids.length > 0) {
      conditions.push({ OR: [{ storageNodeId: null }, { storageNodeId: { in: ids } }] })
    } else if (hasMaster) {
      conditions.push({ storageNodeId: null })
    } else if (ids.length > 0) {
      conditions.push({ storageNodeId: { in: ids } })
    } else {
      // 空值回退默认主节点
      conditions.push({ storageNodeId: null })
    }
  }

  return conditions.length === 1 ? conditions[0] : { AND: conditions }
}
