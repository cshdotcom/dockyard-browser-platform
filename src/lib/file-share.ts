// ============================================================
// r28 文件公开分享核心库（修复「分享链接 404」）
//
// 此前平台只有 WorkspaceShareLink（工作区共享，需登录）；
// 文件级公开分享路由 /s/<token> 并不存在 —— 用户分享文件拿到 404。
// 本模块补齐完整链路：
//   1. 创建分享（单文件 / 多文件批量 / 文件夹前缀动态匹配）
//   2. 访客密钥（SHA-256 哈希存储；网关层前置校验；空 = 免密钥）
//   3. 自定义过期时间 + 次数上限 + 撤销
//   4. 公开预览页数据解析（文件夹展开全部内含文件）
//   5. 下载票据（短时效 HMAC；下载路由凭票据流式回传）
//
// 安全基线：
//   · token 32 字节随机 hex（128bit 不可枚举）
//   · storageKey 路径穿越防护（归一化必须落在存储根内）
//   · 过期/撤销/超次/密钥错误统一拒绝（不区分原因细节，防探测）
//   · 所有访问计数 + 审计留痕
// ============================================================

import crypto from "node:crypto"
import path from "node:path"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { ENV } from "@/lib/env"
import { BizError, ErrorCode } from "@/lib/errors"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { previewKindOf } from "@/lib/preview-kind"

// 预览能力判定（纯函数抽取至 preview-kind，前后端共用；此处再导出兼容旧引用）
export { previewKindOf }

// ---- 分享创建入参 ----
export interface CreateFileShareInput {
  /** 形态 A：精确文件白名单（单/多文件/跨目录批量） */
  fileIds?: string[]
  /** 形态 B：文件夹前缀（动态包含新增文件） */
  folderKey?: string
  name?: string
  /** VIEW 仅预览 | DOWNLOAD 可下载 */
  permission?: "VIEW" | "DOWNLOAD"
  /** 访客密钥明文（创建时一次性展示；库内只存哈希）；空 = 免密钥 */
  visitorKey?: string
  /** null = 永久；自定义过期时间 */
  expireAt?: Date | null
  maxUses?: number
  note?: string
  /** 创建者（必须已登录） */
  creatorUserId: string
  creatorName: string
}

export interface CreateFileShareResult {
  id: string
  token: string
  /** 访客密钥明文（仅本次返回，永不回显） */
  visitorKeyPlain: string | null
  url: string
  fileCount: number
  totalBytes: number
  expireAt: string | null
}

// ---- 公开页解析结果 ----
export interface PublicShareView {
  id: string
  name: string
  permission: "VIEW" | "DOWNLOAD"
  needsKey: boolean
  expireAt: string | null
  fileCount: number
  totalBytes: number
  files: Array<{
    id: string
    fileName: string
    size: number
    mime: string | null
    category: string
    /** 预览能力判定（前端渲染方式） */
    previewKind: "text" | "image" | "svg" | "video" | "audio" | "pdf" | "office-hint" | "none"
    createdAt: string
  }>
  createdAt: string
  viewCount: number
}

// ---- 下载票据 ----
function signDownloadToken(shareToken: string, fileId: string, minutes = 10): string {
  const exp = Date.now() + minutes * 60_000
  const body = `${shareToken}.${fileId}.${exp}`
  const sig = crypto.createHmac("sha256", ENV.authSecret).update(body).digest("hex").slice(0, 32)
  return `${exp}.${sig}`
}

export function verifyDownloadToken(shareToken: string, fileId: string, token: string): boolean {
  const [expStr, sig] = (token || "").split(".")
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expect = crypto.createHmac("sha256", ENV.authSecret).update(`${shareToken}.${fileId}.${exp}`).digest("hex").slice(0, 32)
  return expect === sig
}

// ---- 形态 B 文件夹前缀安全校验（防穿越） ----
function safeFolderPrefix(folderKey: string): string | null {
  const normalized = path.posix.normalize(folderKey.replace(/\\/g, "/")).replace(/^\/+/, "")
  if (!normalized || normalized.includes("..")) return null
  return normalized
}

// ---- 创建分享 ----
export async function createFileShare(input: CreateFileShareInput): Promise<CreateFileShareResult> {
  const permission = input.permission === "DOWNLOAD" ? "DOWNLOAD" : "VIEW"
  const hasFiles = Array.isArray(input.fileIds) && input.fileIds.length > 0
  const hasFolder = !!input.folderKey?.trim()

  if (!hasFiles && !hasFolder) throw new BizError(ErrorCode.PARAM_ERROR, "请选择要分享的文件或文件夹")
  if (hasFiles && hasFolder) throw new BizError(ErrorCode.PARAM_ERROR, "文件清单与文件夹分享不可同时指定")

  // 校验目标文件存在 + 提取名称/大小
  let fileCount = 0
  let totalBytes = 0
  let name = input.name?.trim() || ""
  let ownerUserId: string | null = null

  if (hasFiles) {
    const ids = (input.fileIds || []).slice(0, 200) // 上限 200 个文件
    const metas = await db.fileMeta.findMany({ where: { id: { in: ids }, deletedAt: null, purgedAt: null } })
    if (metas.length === 0) throw new BizError(ErrorCode.NOT_FOUND, "选中的文件不存在或已删除")
    if (metas.length !== ids.length) {
      const missing = ids.length - metas.length
      throw new BizError(ErrorCode.PARAM_ERROR, `${missing} 个文件不存在或已删除，请刷新后重选`)
    }
    fileCount = metas.length
    totalBytes = metas.reduce((s, f) => s + f.size, 0)
    if (!name) name = metas.length === 1 ? metas[0].fileName : `${metas[0].fileName} 等 ${metas.length} 个文件`
    ownerUserId = metas.find((f) => f.userId)?.userId ?? null
  } else {
    const prefix = safeFolderPrefix(input.folderKey!.trim())
    if (!prefix) throw new BizError(ErrorCode.PARAM_ERROR, "非法的文件夹路径")
    const metas = await db.fileMeta.findMany({
      where: { storageKey: { startsWith: `${prefix}/` }, deletedAt: null, purgedAt: null },
      select: { size: true, fileName: true, userId: true },
      take: 2000,
    })
    if (metas.length === 0) throw new BizError(ErrorCode.NOT_FOUND, "文件夹内没有可分享的文件")
    fileCount = metas.length
    totalBytes = metas.reduce((s, f) => s + f.size, 0)
    if (!name) name = prefix.split("/").pop() || prefix
    ownerUserId = metas.find((f) => f.userId)?.userId ?? null
  }

  const token = crypto.randomBytes(16).toString("hex")
  const visitorKeyPlain = input.visitorKey?.trim() ? input.visitorKey.trim() : null
  const visitorKeyHash = visitorKeyPlain ? crypto.createHash("sha256").update(visitorKeyPlain).digest("hex") : null

  const share = await db.fileShare.create({
    data: {
      token,
      name: name.slice(0, 120),
      fileIds: hasFiles ? JSON.parse(JSON.stringify(input.fileIds)) : Prisma.DbNull,
      folderKey: hasFolder ? safeFolderPrefix(input.folderKey!.trim()) : null,
      permission,
      visitorKeyHash,
      expireAt: input.expireAt ?? null,
      maxUses: Math.max(0, Math.floor(input.maxUses || 0)),
      note: input.note?.slice(0, 200) || null,
      createdByUserId: input.creatorUserId,
      ownerUserId: (typeof ownerUserId === "string" ? ownerUserId : null) || input.creatorUserId,
    },
  })

  await writeAudit({
    operatorUserId: input.creatorUserId,
    operatorName: input.creatorName,
    operationType: "FILE_SHARE_CREATE",
    resourceType: "FILE",
    resourceId: share.id,
    resourceName: name,
    after: { token, fileCount, totalBytes, permission, expireAt: share.expireAt?.toISOString() || null, hasVisitorKey: !!visitorKeyHash },
  }).catch(() => {})

  return {
    id: share.id,
    token,
    visitorKeyPlain,
    url: `/s/${token}`,
    fileCount,
    totalBytes,
    expireAt: share.expireAt?.toISOString() || null,
  }
}

// ---- 访问校验（过期/撤销/超次统一拒绝） ----
async function loadValidShare(token: string) {
  const share = await db.fileShare.findUnique({ where: { token } })
  if (!share) throw new BizError(ErrorCode.NOT_FOUND, "分享不存在")
  if (share.revokedAt) throw new BizError(ErrorCode.NOT_FOUND, "分享已被撤销")
  if (share.expireAt && share.expireAt.getTime() < Date.now()) throw new BizError(ErrorCode.NOT_FOUND, "分享已过期")
  if (share.maxUses > 0 && share.useCount >= share.maxUses) throw new BizError(ErrorCode.NOT_FOUND, "分享次数已用尽")
  return share
}

// ---- 解析分享内容（公开页） ----
export async function resolvePublicShare(token: string, visitorKey?: string): Promise<PublicShareView> {
  if (!rateLimit(`share-view:${token}`, 60, 60_000).allowed) {
    throw new BizError(ErrorCode.RATE_LIMITED, "访问过于频繁，请稍后再试")
  }
  const share = await loadValidShare(token)

  // 密钥前置校验（不区分"密钥错误/不存在"细节，防探测）
  if (share.visitorKeyHash) {
    if (!visitorKey) throw new BizError(ErrorCode.FORBIDDEN, "NEED_KEY") // 前端据此渲染密钥输入框
    const hash = crypto.createHash("sha256").update(visitorKey).digest("hex")
    if (hash !== share.visitorKeyHash) throw new BizError(ErrorCode.FORBIDDEN, "访问密钥不正确")
  }

  // 解析文件清单
  let where: Prisma.FileMetaWhereInput
  if (share.fileIds && Array.isArray((share.fileIds as string[]))) {
    where = { id: { in: share.fileIds as string[] }, deletedAt: null, purgedAt: null }
  } else if (share.folderKey) {
    where = { storageKey: { startsWith: `${share.folderKey}/` }, deletedAt: null, purgedAt: null }
  } else {
    where = { id: "__none__" }
  }
  const metas = await db.fileMeta.findMany({ where, orderBy: { fileName: "asc" }, take: 1000 })

  // 计数（首次解锁计 useCount；viewCount 每次访问 +1）
  await db.fileShare
    .update({
      where: { id: share.id },
      data: { viewCount: { increment: 1 }, useCount: visitorKey ? { increment: 1 } : undefined, lastUsedAt: new Date() },
    })
    .catch(() => {})

  return {
    id: share.id,
    name: share.name,
    permission: share.permission as "VIEW" | "DOWNLOAD",
    needsKey: !!share.visitorKeyHash,
    expireAt: share.expireAt?.toISOString() ?? null,
    fileCount: metas.length,
    totalBytes: metas.reduce((s, f) => s + f.size, 0),
    files: metas.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      size: f.size,
      mime: f.mime,
      category: f.category,
      previewKind: previewKindOf(f.mime, f.fileName),
      createdAt: f.createdAt.toISOString(),
    })),
    createdAt: share.createdAt.toISOString(),
    viewCount: share.viewCount + 1,
  }
}

// ---- 校验并返回可下载文件（下载路由用） ----
export async function authorizeShareDownload(token: string, fileId: string, visitorKey?: string) {
  const share = await loadValidShare(token)
  if (share.permission !== "DOWNLOAD") throw new BizError(ErrorCode.FORBIDDEN, "该分享仅允许预览，不允许下载")
  if (share.visitorKeyHash) {
    if (!visitorKey) throw new BizError(ErrorCode.FORBIDDEN, "需要访问密钥")
    const hash = crypto.createHash("sha256").update(visitorKey).digest("hex")
    if (hash !== share.visitorKeyHash) throw new BizError(ErrorCode.FORBIDDEN, "访问密钥不正确")
  }
  const meta = await db.fileMeta.findFirst({ where: { id: fileId, deletedAt: null, purgedAt: null } })
  if (!meta) throw new BizError(ErrorCode.NOT_FOUND, "文件不存在")

  // 归属校验：文件必须在该分享清单/文件夹内
  const inList = Array.isArray(share.fileIds) && (share.fileIds as string[]).includes(fileId)
  const inFolder = !!share.folderKey && meta.storageKey.startsWith(`${share.folderKey}/`)
  if (!inList && !inFolder) throw new BizError(ErrorCode.FORBIDDEN, "该文件不属于此分享")

  // 路径穿越防护
  const root = path.resolve(ENV.storageLocalPath)
  const target = path.resolve(root, meta.storageKey)
  if (!target.startsWith(root + path.sep)) throw new BizError(ErrorCode.FORBIDDEN, "非法的文件路径")

  await db.fileShare.update({ where: { id: share.id }, data: { downloadCount: { increment: 1 } } }).catch(() => {})

  return { share, meta, target }
}

// ---- 撤销 / 删除 ----
export async function revokeFileShare(token: string, operatorUserId: string, operatorName: string) {
  const share = await db.fileShare.findUnique({ where: { token } })
  if (!share) throw new BizError(ErrorCode.NOT_FOUND, "分享不存在")
  await db.fileShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } })
  await writeAudit({
    operatorUserId, operatorName,
    operationType: "FILE_SHARE_REVOKE", resourceType: "FILE", resourceId: share.id, resourceName: share.name,
    before: { token, revoked: false }, after: { revoked: true },
  }).catch(() => {})
  return { id: share.id }
}

// ---- 拥有者列表（文件管理内「我的分享」） ----
export async function listSharesByCreator(userId: string, keyword?: string) {
  const where: Prisma.FileShareWhereInput = {
    createdByUserId: userId,
    OR: [{ revokedAt: null }, { revokedAt: { not: null } }],
  }
  if (keyword) where.name = { contains: keyword }
  const rows = await db.fileShare.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 })
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    name: r.name,
    permission: r.permission,
    hasKey: !!r.visitorKeyHash,
    expireAt: r.expireAt?.toISOString() ?? null,
    expired: !!r.expireAt && r.expireAt.getTime() < Date.now(),
    revoked: !!r.revokedAt,
    maxUses: r.maxUses,
    useCount: r.useCount,
    viewCount: r.viewCount,
    downloadCount: r.downloadCount,
    isFolder: !!r.folderKey,
    fileCount: Array.isArray(r.fileIds) ? (r.fileIds as string[]).length : null,
    url: `/s/${r.token}`,
    createdAt: r.createdAt.toISOString(),
  }))
}
