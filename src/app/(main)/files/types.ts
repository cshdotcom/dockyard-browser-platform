// 用户云盘 /files —— 服务端/客户端共享类型（纯类型模块，无客户端/服务端指令）

export interface UserFileRow {
  id: string
  fileName: string
  storageKey: string
  /** storageKey 的父目录（"" = 根目录；用于多标签页文件夹导航） */
  folder: string
  size: number
  mime: string | null
  category: string
  isFavorite: boolean
  createdAt: string
  expireAt: string | null
  expired: boolean
}

export interface MyShareRow {
  id: string
  token: string
  name: string
  permission: string
  hasKey: boolean
  expireAt: string | null
  expired: boolean
  revoked: boolean
  maxUses: number
  useCount: number
  viewCount: number
  downloadCount: number
  isFolder: boolean
  fileCount: number | null
  url: string
  createdAt: string
}

export const USER_CATEGORY_LABEL: Record<string, string> = {
  GENERAL: "普通文件",
  AVATAR: "头像",
  RECORDING: "会话录像",
  SCREENSHOT: "屏幕截图",
  SNAPSHOT: "环境快照",
  LOG: "日志",
  REPORT: "报表",
}
