"use server"

// ============================================================
// r28：文件管理器 Server Actions（全盘/存储/用户空间三域）
//   ADMIN+     → ROOT_FS（容器全盘，只读浏览+受控写）/ STORAGE（平台存储）
//   USER       → HOME（storage/home/<userId> 专属空间）
// 全部操作审计；写操作有敏感目录保护（file-explorer.isWriteDenied）
// ============================================================

import { actionHandler, type ActionResult } from "@/lib/api"
import { zodValidate } from "@/lib/validators"
import { z } from "zod"
import { requireAuth, requireAdmin } from "@/lib/permissions"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { trackBehavior } from "@/lib/risk"
import { ENV } from "@/lib/env"
import {
  type FileDomain, type FileEntry, resolveDomainPath, isWriteDenied, listDir,
  readTextFile, writeTextFile, zipPaths, extractArchive, removePath, movePath, copyPath,
  searchFiles, dirSize, kindOf, MAX_EDIT_BYTES,
} from "@/lib/file-explorer"
import { promises as fsp } from "fs"
import path from "path"
import { randomBytes } from "crypto"

// ---- 域解析（含 HOME 用户根锁定） ----
async function domainRoots(userId: string): Promise<{ ROOT_FS: string; STORAGE: string; HOME: string }> {
  const home = path.join(ENV.storageLocalPath, "home", userId)
  await fsp.mkdir(home, { recursive: true }).catch(() => null)
  return { ROOT_FS: "/", STORAGE: path.resolve(ENV.storageLocalPath), HOME: home }
}

const relSchema = z.string().max(1024).default("")

// ---- 1. 目录浏览 ----
const browseSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: relSchema,
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(10).max(500).default(50),
  sortBy: z.enum(["name", "size", "mtime"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  keyword: z.string().max(200).optional(),
  kinds: z.array(z.string().max(20)).max(10).optional(),
  timeFrom: z.string().datetime().optional(),
  timeTo: z.string().datetime().optional(),
  minSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})

export async function browseFilesAction(input: unknown): Promise<ActionResult<{ entries: FileEntry[]; total: number; page: number; pageSize: number; parentRel: string; domain: string; canWrite: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(browseSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"

    // 域权限：ROOT_FS/STORAGE 仅管理员；HOME 自动锁定本人根
    const domain: FileDomain = p.domain
    if ((domain === "ROOT_FS" || domain === "STORAGE") && !isAdmin) {
      return biz403("该目录域仅管理员可访问")
    }
    const roots = await domainRoots(ctx.userId)
    const target = domain === "HOME" ? { abs: roots.HOME, ok: true } : resolveDomainPath(roots, domain, domain === "STORAGE" ? p.path : p.path)
    if (!target.ok) return biz403("非法路径")

    const relBase = domain === "HOME" ? p.path : p.path
    const { abs } = target
    const r = await listDir(abs, {
      page: p.page, pageSize: p.pageSize,
      sortBy: p.sortBy, sortDir: p.sortDir,
      keyword: p.keyword, kinds: p.kinds,
      timeFrom: p.timeFrom ? new Date(p.timeFrom).getTime() : undefined,
      timeTo: p.timeTo ? new Date(p.timeTo).getTime() : undefined,
      minSize: p.minSize, maxSize: p.maxSize,
    })
    // 相对路径补全（前端导航用）
    const entries = r.entries.map((e) => ({ ...e, rel: path.posix.join(p.path || ".", e.name) }))

    // 写权限：ROOT_FS 系统目录拒写；STORAGE 的 system/profiles 拒写；HOME 全可写
    const canWrite = !isWriteDenied(domain, abs, ENV.storageLocalPath)
    return { entries, total: r.total, page: r.page, pageSize: r.pageSize, parentRel: path.posix.dirname(p.path || "."), domain, canWrite }
  })
}

function biz403(msg: string): never {
  throw Object.assign(new Error(msg), { code: 403 })
}

// ---- 2. 文本读取（编辑器） ----
const readSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024),
})

export async function readFileAction(input: unknown): Promise<ActionResult<{ content: string; size: number; truncated: boolean; kind: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(readSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("仅管理员可读取该域")

    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")

    const st = await fsp.stat(abs).catch(() => null)
    if (!st || !st.isFile()) return biz403("文件不存在")

    const name = path.basename(abs)
    const kind = kindOf(name)
    const r = await readTextFile(abs, name).catch((e: Error) => ({ error: e.message }))
    if ("error" in r) return biz403((r as { error: string }).error)

    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_VIEW", resourceType: "FILE",
      resourceName: name, severity: "INFO",
      after: { domain: p.domain, path: p.path, size: (r as { size: number }).size },
    }).catch(() => null)
    return { content: (r as { content: string }).content, size: (r as { size: number }).size, truncated: (r as { truncated: boolean }).truncated, kind }
  })
}

// ---- 3. 文本保存 ----
const writeSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024),
  content: z.string().max(MAX_EDIT_BYTES),
})

export async function writeFileAction(input: unknown): Promise<ActionResult<{ size: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(writeSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("仅管理员可写该域")

    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")
    if (isWriteDenied(p.domain, abs, ENV.storageLocalPath)) return biz403("该目录为平台敏感目录，禁止修改（策略防篡改）")

    const before = await fsp.stat(abs).catch(() => null)
    const r = await writeTextFile(abs, p.content).catch((e: Error) => ({ error: e.message }))
    if ("error" in r) return biz403((r as { error: string }).error)

    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_EDIT", resourceType: "FILE",
      resourceName: path.basename(abs), severity: "WARN",
      before: { size: before?.size ?? 0 },
      after: { domain: p.domain, path: p.path, size: (r as { size: number }).size },
    }).catch(() => null)
    await trackBehavior(ctx.userId, "CREATE").catch(() => null)
    return { size: (r as { size: number }).size }
  })
}

// ---- 4. 新建（目录 / 空文件） ----
const createSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  dir: z.string().max(1024).default(""),
  name: z.string().min(1).max(255),
  type: z.enum(["dir", "file"]),
})

export async function createEntryAction(input: unknown): Promise<ActionResult<{ created: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(createSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("仅管理员可写该域")
    if (/[\\/\0]/.test(p.name)) return biz403("名称不能包含路径分隔符")

    const roots = await domainRoots(ctx.userId)
    const { abs: dirAbs, ok } = resolveDomainPath(roots, p.domain, p.dir)
    if (!ok) return biz403("非法路径")

    const abs = path.join(dirAbs, p.name)
    if (isWriteDenied(p.domain, abs, ENV.storageLocalPath)) return biz403("敏感目录禁止创建")

    if (p.type === "dir") {
      await fsp.mkdir(abs, { recursive: false }).catch((e: Error) => biz403(e.message))
    } else {
      await fsp.writeFile(abs, "", { flag: "wx" }).catch((e: Error) => biz403(e.message))
    }
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_CREATE", resourceType: "FILE", resourceName: p.name, severity: "INFO",
      after: { domain: p.domain, dir: p.dir, type: p.type },
    }).catch(() => null)
    return { created: true }
  })
}

// ---- 5. 重命名 ----
const renameSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024),
  newName: z.string().min(1).max(255),
})

export async function renameEntryAction(input: unknown): Promise<ActionResult<{ renamed: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(renameSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("仅管理员可写该域")
    if (/[\\/\0]/.test(p.newName)) return biz403("名称不能包含路径分隔符")

    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")
    if (isWriteDenied(p.domain, abs, ENV.storageLocalPath)) return biz403("敏感目录禁止重命名")

    const dest = path.join(path.dirname(abs), p.newName)
    await fsp.rename(abs, dest).catch((e: Error) => biz403(e.message))
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_RENAME", resourceType: "FILE", resourceName: path.basename(abs), severity: "WARN",
      before: { path: p.path }, after: { newName: p.newName, domain: p.domain },
    }).catch(() => null)
    return { renamed: true }
  })
}

// ---- 6. 批量删除（软删入回收站：STORAGE/HOME 域） ----
const deleteSchema = z.object({
  items: z.array(z.object({
    domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
    path: z.string().max(1024),
    isDir: z.boolean().default(false),
  })).min(1).max(100),
  reason: z.string().max(200).optional(),
})

export async function deleteEntriesAction(input: unknown): Promise<ActionResult<{ deleted: number; failed: number; errors: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(deleteSchema, input)
    const roots = await domainRoots(ctx.userId)
    let deleted = 0
    const errors: string[] = []

    for (const item of p.items) {
      const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
      if ((item.domain === "ROOT_FS" || item.domain === "STORAGE") && !isAdmin) { errors.push(`${item.path}: 无权限`); continue }
      const { abs, ok } = resolveDomainPath(roots, item.domain, item.path)
      if (!ok) { errors.push(`${item.path}: 非法路径`); continue }
      if (isWriteDenied(item.domain, abs, ENV.storageLocalPath)) { errors.push(`${item.path}: 敏感目录禁止删除`); continue }

      const st = await fsp.stat(abs).catch(() => null)
      if (!st) { errors.push(`${item.path}: 不存在`); continue }

      // 回收站登记（软删快照；物理删除在 purge 时执行）
      const size = st.isDirectory() ? await dirSize(abs) : st.size
      const recycle = await import("@/lib/recycle")
      const name = path.basename(abs)

      const r = await removePath(abs)
      if (!r.ok) { errors.push(`${item.path}: ${r.error}`); continue }
      deleted++
      void recycle.moveToRecycle({
        resourceType: "FILE",
        resourceId: `fx:${ctx.userId}:${item.path}`,
        resourceName: name,
        ownerUserId: item.domain === "HOME" ? ctx.userId : null,
        deletedByUserId: ctx.userId,
        deletedByType: ctx.role === "USER" ? "USER" : "ADMIN",
        reason: `${p.reason || "文件管理器删除"} @${item.domain}:${item.path}`,
        operatorName: ctx.username,
      }).catch(() => null)
      void writeAudit({
        operatorUserId: ctx.userId, operatorName: ctx.username,
        operationType: "FILE_DELETE", resourceType: "FILE", resourceName: name, severity: "WARN",
        ownerUserId: item.domain === "HOME" ? ctx.userId : undefined,
        after: { domain: item.domain, path: item.path, size, reason: p.reason },
      }).catch(() => null)
    }
    await trackBehavior(ctx.userId, "DELETE").catch(() => null)
    return { deleted, failed: p.items.length - deleted, errors: errors.slice(0, 10) }
  })
}

// ---- 7. 移动 / 复制（批量；跨域受限） ----
const transferSchema = z.object({
  items: z.array(z.object({
    domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
    path: z.string().max(1024),
  })).min(1).max(50),
  destDomain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  destDir: z.string().max(1024).default(""),
  mode: z.enum(["move", "copy"]),
})

export async function transferEntriesAction(input: unknown): Promise<ActionResult<{ moved: number; failed: number; errors: string[] }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(transferSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    const roots = await domainRoots(ctx.userId)

    if ((p.destDomain === "ROOT_FS" || p.destDomain === "STORAGE") && !isAdmin) return biz403("目标域仅管理员可写")
    const { abs: destAbs, ok: destOk } = resolveDomainPath(roots, p.destDomain, p.destDir)
    if (!destOk) return biz403("目标路径非法")
    if (isWriteDenied(p.destDomain, destAbs, ENV.storageLocalPath)) return biz403("目标为敏感目录")

    let moved = 0
    const errors: string[] = []
    for (const item of p.items) {
      if ((item.domain === "ROOT_FS" || item.domain === "STORAGE") && !isAdmin) { errors.push(`${item.path}: 源域无权限`); continue }
      const { abs, ok } = resolveDomainPath(roots, item.domain, item.path)
      if (!ok) { errors.push(`${item.path}: 非法路径`); continue }
      if (p.mode === "move" && isWriteDenied(item.domain, abs, ENV.storageLocalPath)) { errors.push(`${item.path}: 敏感目录禁止移出`); continue }

      try {
        if (p.mode === "move") {
          const r = await movePath(abs, destAbs)
          if (!r.ok) { errors.push(`${item.path}: ${r.error}`); continue }
        } else {
          await copyPath(abs, path.join(destAbs, path.basename(abs)))
        }
        moved++
      } catch (e) {
        errors.push(`${item.path}: ${(e as Error).message}`)
      }
    }
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: p.mode === "move" ? "FILE_MOVE" : "FILE_COPY", resourceType: "FILE",
      resourceName: `${p.items.length} 项`, severity: "INFO",
      after: { dest: `${p.destDomain}:${p.destDir}`, moved },
    }).catch(() => null)
    return { moved, failed: p.items.length - moved, errors: errors.slice(0, 10) }
  })
}

// ---- 8. 压缩 / 解压 ----
const archiveSchema = z.object({
  items: z.array(z.object({
    domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
    path: z.string().max(1024),
  })).min(1).max(20),
  destDomain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  destDir: z.string().max(1024).default(""),
  archiveName: z.string().min(1).max(255),
  password: z.string().max(128).optional(),
})

export async function archiveEntriesAction(input: unknown): Promise<ActionResult<{ archiveName: string; size: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(archiveSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    const roots = await domainRoots(ctx.userId)

    if ((p.destDomain === "ROOT_FS" || p.destDomain === "STORAGE") && !isAdmin) return biz403("目标域仅管理员可写")
    const { abs: destAbs, ok: destOk } = resolveDomainPath(roots, p.destDomain, p.destDir)
    if (!destOk || isWriteDenied(p.destDomain, destAbs, ENV.storageLocalPath)) return biz403("目标路径不可写")

    const name = p.archiveName.endsWith(".zip") ? p.archiveName : `${p.archiveName}.zip`
    const absList: string[] = []
    for (const item of p.items) {
      const { abs, ok } = resolveDomainPath(roots, item.domain, item.path)
      if (!ok) continue
      absList.push(abs)
    }
    if (absList.length === 0) return biz403("没有可压缩的有效路径")

    const dest = path.join(destAbs, name)
    const r = await zipPaths(absList, dest, p.password)
    if (!r.ok) return biz403(r.error || "压缩失败")

    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_ARCHIVE", resourceType: "FILE", resourceName: name, severity: "INFO",
      after: { sources: absList.length, size: r.size, encrypted: !!p.password, dest: `${p.destDomain}:${p.destDir}` },
    }).catch(() => null)
    return { archiveName: name, size: r.size }
  })
}

const extractSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024),
  password: z.string().max(128).optional(),
  destDir: z.string().max(1024).optional(), // 缺省=归档所在目录
})

export async function extractArchiveAction(input: unknown): Promise<ActionResult<{ extracted: boolean; destDir: string }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(extractSchema, input)
    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")

    const destAbs = p.destDir
      ? resolveDomainPath(roots, p.domain, p.destDir).abs
      : path.join(path.dirname(abs), path.basename(abs).replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|gz)$/i, ""))
    if (isWriteDenied(p.domain, destAbs, ENV.storageLocalPath)) return biz403("目标目录敏感不可写")

    const r = await extractArchive(abs, destAbs, p.password)
    if (!r.ok) return biz403(r.error || "解压失败（如加密压缩包请填写密码）")

    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_EXTRACT", resourceType: "FILE", resourceName: path.basename(abs), severity: "INFO",
      after: { destDir: p.destDir || "(同目录)", passwordUsed: !!p.password },
    }).catch(() => null)
    return { extracted: true, destDir: p.destDir || path.posix.dirname(p.path) }
  })
}

// ---- 9. 搜索（文件名/内容/递归开关） ----
const searchSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024).default(""),
  keyword: z.string().min(1).max(200),
  recursive: z.boolean().default(true),
  content: z.boolean().default(false),
  maxResults: z.number().int().min(10).max(500).default(200),
})

export async function searchFilesAction(input: unknown): Promise<ActionResult<{ hits: Array<{ rel: string; isDir: boolean; size: number; mtime: string; kind: string; contentLine?: string }>; scanned: number; truncated: boolean; tookMs: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(searchSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("该域仅管理员可搜索")

    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")

    const start = Date.now()
    const r = await searchFiles(abs, p.path, {
      keyword: p.keyword, recursive: p.recursive, content: p.content, maxResults: p.maxResults,
    })
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_SEARCH", resourceType: "FILE", severity: "INFO",
      after: { domain: p.domain, path: p.path, keyword: p.keyword.slice(0, 80), hits: r.hits.length, scanned: r.scanned, content: p.content },
    }).catch(() => null)
    return {
      hits: r.hits.map((h) => ({ rel: h.rel, isDir: h.isDir, size: h.size, mtime: h.mtime, kind: h.kind, contentLine: h.contentLine })),
      scanned: r.scanned, truncated: r.truncated, tookMs: Date.now() - start,
    }
  })
}

// ---- 10. 目录大小统计 ----
const dusizeSchema = z.object({
  domain: z.enum(["ROOT_FS", "STORAGE", "HOME"]).default("STORAGE"),
  path: z.string().max(1024),
})

export async function dirSizeAction(input: unknown): Promise<ActionResult<{ size: number }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(dusizeSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    if ((p.domain === "ROOT_FS" || p.domain === "STORAGE") && !isAdmin) return biz403("仅管理员")
    const roots = await domainRoots(ctx.userId)
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")
    const size = await dirSize(abs)
    return { size }
  })
}

// ---- 11. 分享链接（r31 增强：用户+用户组双多选 / 自定义到期时间） ----
const shareSchema = z.object({
  domain: z.enum(["STORAGE", "HOME"]).default("HOME"), // 分享仅限 STORAGE/HOME（ROOT_FS 全盘文件禁止外链）
  path: z.string().max(1024),
  accessMode: z.enum(["PUBLIC", "LOGIN", "USERS"]).default("LOGIN"),
  allowedUserIds: z.array(z.string().max(64)).max(100).optional(),
  allowedGroupIds: z.array(z.string().max(64)).max(100).optional(), // r31：用户组名单（组员均可访问）
  expiresDays: z.number().int().min(0).max(3650).default(7), // 0=永久（与 expiresAt 二选一）
  expiresAt: z.string().datetime().optional(), // r31：自定义到期时刻（ISO；优先于 expiresDays）
  maxViews: z.number().int().min(0).max(1000000).optional(), // 0/undefined=不限
  maxDownloads: z.number().int().min(0).max(1000000).optional(),
  downloadKBps: z.number().int().min(0).max(1024 * 1024).optional(),
  note: z.string().max(200).optional(),
})

export async function createShareLinkAction(input: unknown): Promise<ActionResult<{ token: string; url: string; expiresAt: string | null }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(shareSchema, input)
    const roots = await domainRoots(ctx.userId)
    if (p.domain === "STORAGE" && !(ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN")) return biz403("仅管理员可分享存储域文件")
    const { abs, ok } = resolveDomainPath(roots, p.domain, p.path)
    if (!ok) return biz403("非法路径")
    const st = await fsp.stat(abs).catch(() => null)
    if (!st) return biz403("文件不存在")

    // r31：USERS 模式名单校验（用户/组存在性 + 去重）
    if (p.accessMode === "USERS") {
      const uids = [...new Set(p.allowedUserIds || [])]
      const gids = [...new Set(p.allowedGroupIds || [])]
      if (uids.length === 0 && gids.length === 0) return biz403("USERS 模式需至少选择一位用户或一个用户组")
      if (uids.length > 0) {
        const found = await db.user.count({ where: { id: { in: uids }, deletedAt: null } })
        if (found !== uids.length) return biz403("存在无效用户（可能已删除）")
      }
      if (gids.length > 0) {
        const foundG = await db.group.count({ where: { id: { in: gids }, deletedAt: null } })
        if (foundG !== gids.length) return biz403("存在无效用户组")
      }
    }

    // 到期时间：自定义时刻优先；其次天数；0=永久
    let expiresAt: Date | null = null
    if (p.expiresAt) {
      const t = new Date(p.expiresAt).getTime()
      if (!Number.isFinite(t)) return biz403("自定义到期时间格式非法")
      if (t <= Date.now() + 60_000) return biz403("到期时间必须晚于当前时间至少 1 分钟")
      expiresAt = new Date(t)
    } else if (p.expiresDays > 0) {
      expiresAt = new Date(Date.now() + p.expiresDays * 86400_000)
    }

    const token = randomBytes(24).toString("hex")
    const sizeBytes = st.isDirectory() ? await dirSize(abs).catch(() => 0) : st.size
    await db.fileShareLink.create({
      data: {
        token, domain: p.domain, filePath: p.path,
        fileName: path.basename(abs), sizeBytes,
        isDir: st.isDirectory(),
        ownerUserId: ctx.userId,
        accessMode: p.accessMode,
        allowedUsers: p.accessMode === "USERS"
          ? { userIds: [...new Set(p.allowedUserIds || [])], groupIds: [...new Set(p.allowedGroupIds || [])] }
          : undefined,
        expiresAt,
        maxViews: p.maxViews && p.maxViews > 0 ? p.maxViews : null,
        maxDownloads: p.maxDownloads && p.maxDownloads > 0 ? p.maxDownloads : null,
        downloadKBps: p.downloadKBps && p.downloadKBps > 0 ? p.downloadKBps : null,
        note: p.note,
      },
    })
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_SHARE_CREATE", resourceType: "FILE", resourceName: path.basename(abs), severity: "WARN",
      after: {
        token: token.slice(0, 8) + "…", accessMode: p.accessMode,
        targetUsers: (p.allowedUserIds || []).length, targetGroups: (p.allowedGroupIds || []).length,
        isDir: st.isDirectory(), expiresAt: expiresAt?.toISOString() || "永久",
      },
    }).catch(() => null)
    return { token, url: `/share/${token}`, expiresAt: expiresAt?.toISOString() || null }
  })
}

// ---- r31：分享目标选项（用户 + 用户组；供双多选面板） ----
export async function listShareTargetOptionsAction(input: unknown): Promise<ActionResult<{
  users: Array<{ id: string; username: string; displayName: string | null }>
  groups: Array<{ id: string; name: string; memberCount: number }>
}>> {
  return actionHandler(async () => {
    await requireAuth()
    const p = zodValidate(z.object({ keyword: z.string().max(64).optional() }), input)
    const kw = p.keyword?.trim()
    const [users, groups] = await Promise.all([
      db.user.findMany({
        where: {
          deletedAt: null, enabled: true,
          ...(kw ? { OR: [{ username: { contains: kw } }, { displayName: { contains: kw } }] } : {}),
        },
        select: { id: true, username: true, displayName: true },
        orderBy: { username: "asc" },
        take: 200,
      }),
      db.group.findMany({
        where: { deletedAt: null, ...(kw ? { name: { contains: kw } } : {}) },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 100,
      }).catch(() => [] as Array<{ id: string; name: string }>),
    ])
    const memberCounts = await db.groupUser.groupBy({ by: ["groupId"], _count: { id: true } }).catch(() => [])
    const countByG = new Map<string, number>(memberCounts.map((m) => [m.groupId, m._count.id] as [string, number]))
    return {
      users,
      groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: countByG.get(g.id) || 0 })),
    }
  })
}

// ---- r31：分享延期（自定义新到期时刻；所有者/管理员） ----
const extendSchema = z.object({
  token: z.string().length(48),
  expiresAt: z.string().datetime().nullable(), // null=永久
})

export async function extendShareLinkAction(input: unknown): Promise<ActionResult<{ expiresAt: string | null }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(extendSchema, input)
    const isAdmin = ctx.role === "ADMIN" || ctx.role === "SUPER_ADMIN"
    const row = await db.fileShareLink.findFirst({ where: { token: p.token, ...(isAdmin ? {} : { ownerUserId: ctx.userId }) } })
    if (!row) return biz403("分享不存在或无权操作")
    if (row.revokedAt) return biz403("分享已被撤销，无法延期")
    let expiresAt: Date | null = null
    if (p.expiresAt) {
      const t = new Date(p.expiresAt).getTime()
      if (!Number.isFinite(t) || t <= Date.now() + 60_000) return biz403("新到期时间必须晚于当前时间至少 1 分钟")
      expiresAt = new Date(t)
    }
    await db.fileShareLink.update({ where: { id: row.id }, data: { expiresAt } })
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_SHARE_EXTEND", resourceType: "FILE", resourceName: row.fileName, severity: "WARN",
      before: { expiresAt: row.expiresAt?.toISOString() || "永久" },
      after: { token: p.token.slice(0, 8) + "…", expiresAt: expiresAt?.toISOString() || "永久" },
    }).catch(() => null)
    return { expiresAt: expiresAt?.toISOString() || null }
  })
}

export async function listMyShareLinksAction(): Promise<ActionResult<Array<{
  token: string; fileName: string; isDir: boolean; accessMode: string; expiresAt: string | null
  viewCount: number; downloadCount: number; revokedAt: string | null; createdAt: string; url: string
}>>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const rows = await db.fileShareLink.findMany({
      where: { ownerUserId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return rows.map((r) => ({
      token: r.token, fileName: r.fileName, isDir: r.isDir, accessMode: r.accessMode,
      expiresAt: r.expiresAt?.toISOString() || null,
      viewCount: r.viewCount, downloadCount: r.downloadCount,
      revokedAt: r.revokedAt?.toISOString() || null,
      createdAt: r.createdAt.toISOString(),
      url: `/share/${r.token}`,
    }))
  })
}

const revokeSchema = z.object({ token: z.string().length(48) })

export async function revokeShareLinkAction(input: unknown): Promise<ActionResult<{ revoked: boolean }>> {
  return actionHandler(async () => {
    const ctx = await requireAuth()
    const p = zodValidate(revokeSchema, input)
    const row = await db.fileShareLink.findFirst({ where: { token: p.token, ownerUserId: ctx.userId } })
    if (!row) return biz403("分享不存在或无权操作")
    await db.fileShareLink.update({ where: { id: row.id }, data: { revokedAt: new Date() } })
    void writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "FILE_SHARE_REVOKE", resourceType: "FILE", resourceName: row.fileName, severity: "WARN",
      after: { token: p.token.slice(0, 8) + "…" },
    }).catch(() => null)
    return { revoked: true }
  })
}
