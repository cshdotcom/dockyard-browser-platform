/**
 * r28：文件管理器核心库（纯函数 + Server Action 共用底层）
 *
 * 三个访问域：
 *   ROOT_FS —— 整个容器根目录 /（仅 ADMIN+；管理员全盘管理）
 *   STORAGE —— 平台存储根 storage/（ADMIN+；含 profiles/recordings 等业务目录）
 *   HOME    —— 用户专属空间 storage/home/<userId>/（USER；进入时锁定）
 *
 * 安全铁律：
 *   1. 所有路径 resolve 归一化后必须落在访问域根内（穿越即拒绝）
 *   2. 文本编辑/内容搜索限定文本类 MIME 且 ≤ 2MB（防二进制注入与内存放大）
 *   3. 敏感目录拒写（storage/system、storage/profiles 全部、策略目录、/etc /proc /sys /dev /run）
 *   4. 全部操作走审计（调用方负责）
 */

import { promises as fsp } from "fs"
import path from "path"

export type FileDomain = "ROOT_FS" | "STORAGE" | "HOME" | "RECORDING" | "SCREENSHOT" // RECORDING/SCREENSHOT：r33 用户录像/截图域（storage/recordings|screenshots/<userId>；只读+下载，不可写）

export const MAX_EDIT_BYTES = 2 * 1024 * 1024 // 文本编辑上限
export const MAX_SEARCH_FILES = 2000 // 搜索扫描文件数上限
export const MAX_SEARCH_CONTENT_BYTES = 1024 * 1024 // 单文件内容搜索上限

// ---- 文本类扩展名（编辑器 + 内容搜索共用） ----
export const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".log", ".json", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".less",
  ".html", ".htm", ".xml", ".svg", ".csv", ".tsv", ".sql", ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php",
  ".env", ".gitignore", ".dockerfile", ".properties", ".cfg", ".diff", ".patch",
])
export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"])
export const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".flv"])
export const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"])
export const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".tar.gz", ".tar.bz2", ".tar.xz"])
export const PDF_EXTS = new Set([".pdf"])

export function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i < 0 ? "" : name.slice(i).toLowerCase()
}

export function kindOf(name: string): "dir" | "text" | "image" | "video" | "audio" | "archive" | "pdf" | "binary" {
  const e = extOf(name)
  if (IMAGE_EXTS.has(e)) return "image"
  if (VIDEO_EXTS.has(e)) return "video"
  if (AUDIO_EXTS.has(e)) return "audio"
  if (ARCHIVE_EXTS.has(e) || name.endsWith(".tar.gz") || name.endsWith(".tar.bz2") || name.endsWith(".tar.xz")) return "archive"
  if (PDF_EXTS.has(e)) return "pdf"
  if (TEXT_EXTS.has(e) || !e) return "text" // 无扩展名按文本尝试（读取时会验证）
  return "binary"
}

export function isTextFile(name: string): boolean {
  const e = extOf(name)
  return TEXT_EXTS.has(e)
}

// ---- 域根解析 ----
export interface DomainRoots {
  ROOT_FS: string
  STORAGE: string
  HOME?: string
  RECORDING?: string // r33：用户录像域根（storage/recordings/<userId>）
  SCREENSHOT?: string // r33：用户截图域根（storage/screenshots/<userId>）
}

export function resolveDomainPath(roots: DomainRoots, domain: FileDomain, rel: string): { abs: string; ok: boolean } {
  const root = domain === "ROOT_FS" ? roots.ROOT_FS : domain === "STORAGE" ? roots.STORAGE : domain === "RECORDING" ? roots.RECORDING || "" : domain === "SCREENSHOT" ? roots.SCREENSHOT || "" : roots.HOME || ""
  if (!root) return { abs: "", ok: false }
  const abs = path.resolve(root, rel || ".")
  const rootNorm = path.resolve(root)
  if (abs !== rootNorm && !abs.startsWith(rootNorm + path.sep)) return { abs: "", ok: false }
  return { abs, ok: true }
}

// ---- 敏感写保护（ROOT_FS 域系统目录 + STORAGE 域平台核心目录） ----
const ROOT_FS_WRITE_DENY = ["/proc", "/sys", "/dev", "/run", "/etc", "/boot", "/var/lib", "/usr", "/lib", "/lib64", "/bin", "/sbin"]
const STORAGE_WRITE_DENY_PARTS = ["system", path.join("profiles"), path.join("profiles", "*")] // 台账/UID/策略文件

export function isWriteDenied(domain: FileDomain, abs: string, storageRoot: string): boolean {
  if (domain === "ROOT_FS") {
    return ROOT_FS_WRITE_DENY.some((d) => abs === d || abs.startsWith(d + path.sep))
  }
  // r33：录像/截图域整体只读（删除/移动/重命名/上传全部拒绝；回放/下载经专用链路）
  if (domain === "RECORDING" || domain === "SCREENSHOT") return true
  if (domain === "STORAGE" || domain === "HOME") {
    const rel = path.relative(path.resolve(storageRoot), abs)
    if (rel.startsWith("..")) return true
    const first = rel.split(path.sep)[0]
    if (domain === "STORAGE") {
      if (first === "system" || first === "profiles") return true // 台账与策略目录只读（策略文件防篡改）
    }
    // HOME 域已在 resolve 时限定用户根
  }
  return false
}

// ---- 目录列表（分页 + 排序） ----
export interface FileEntry {
  name: string
  rel: string
  isDir: boolean
  size: number
  mtime: string
  kind: "dir" | "text" | "image" | "video" | "audio" | "archive" | "pdf" | "binary"
  ext: string
}

export async function listDir(abs: string, opts: {
  page: number
  pageSize: number
  sortBy?: "name" | "size" | "mtime"
  sortDir?: "asc" | "desc"
  keyword?: string
  kinds?: string[] // kind 过滤（image/text/...）
  timeFrom?: number
  timeTo?: number
  minSize?: number
  maxSize?: number
}): Promise<{ entries: FileEntry[]; total: number; page: number; pageSize: number; parent: string }> {
  let dirents
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true })
  } catch {
    return { entries: [], total: 0, page: opts.page, pageSize: opts.pageSize, parent: "" }
  }

  const parent = path.dirname(abs)
  let entries: FileEntry[] = []
  for (const d of dirents) {
    const full = path.join(abs, d.name)
    let st
    try {
      st = await fsp.stat(full)
    } catch { continue }
    const kind = d.isDirectory() ? "dir" : kindOf(d.name)
    entries.push({
      name: d.name,
      rel: path.relative(abs, full),
      isDir: d.isDirectory(),
      size: st.size,
      mtime: st.mtime.toISOString(),
      kind,
      ext: extOf(d.name),
    })
  }

  // 过滤
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase()
    entries = entries.filter((e) => e.name.toLowerCase().includes(kw))
  }
  if (opts.kinds && opts.kinds.length > 0) {
    entries = entries.filter((e) => e.isDir || opts.kinds!.includes(e.kind))
  }
  if (opts.timeFrom || opts.timeTo) {
    entries = entries.filter((e) => {
      const t = new Date(e.mtime).getTime()
      if (opts.timeFrom && t < opts.timeFrom) return false
      if (opts.timeTo && t > opts.timeTo) return false
      return true
    })
  }
  if (opts.minSize || opts.maxSize) {
    entries = entries.filter((e) => {
      if (e.isDir) return true
      if (opts.minSize && e.size < opts.minSize) return false
      if (opts.maxSize && e.size > opts.maxSize) return false
      return true
    })
  }

  // 排序：目录优先，然后按字段
  const sortBy = opts.sortBy || "name"
  const mul = opts.sortDir === "desc" ? -1 : 1
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let r = 0
    if (sortBy === "size") r = a.size - b.size
    else if (sortBy === "mtime") r = new Date(a.mtime).getTime() - new Date(b.mtime).getTime()
    else r = a.name.localeCompare(b.name, "zh")
    return r * mul
  })

  const total = entries.length
  const start = (opts.page - 1) * opts.pageSize
  const pageEntries = entries.slice(start, start + opts.pageSize)
  return { entries: pageEntries, total, page: opts.page, pageSize: opts.pageSize, parent }
}

// ---- 目录大小（递归，限深/限文件数防卡死） ----
export async function dirSize(abs: string, budget = { files: 5000, bytes: 0 }): Promise<number> {
  let total = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 16 || budget.files <= 0) return
    let dirents
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of dirents) {
      if (budget.files <= 0) return
      budget.files--
      const full = path.join(dir, d.name)
      if (d.isDirectory()) await walk(full, depth + 1)
      else {
        try { const st = await fsp.stat(full); total += st.size } catch { /* skip */ }
      }
    }
  }
  await walk(abs, 0)
  return total
}

// ---- 文本读取/写入（编辑器） ----
export async function readTextFile(abs: string, name: string): Promise<{ content: string; size: number; truncated: boolean }> {
  if (!isTextFile(name) && !TEXT_EXTS.has(extOf(name))) {
    // 无扩展名的宽松尝试：读首块验证可打印率
    const fh = await fsp.open(abs, "r")
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, 4096, 0)
      const sample = buf.subarray(0, bytesRead)
      let printable = 0
      for (const b of sample) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++
      if (sample.length > 0 && printable / sample.length < 0.9) throw new Error("二进制文件不可编辑")
    } finally {
      await fh.close()
    }
  }
  const st = await fsp.stat(abs)
  if (st.size > MAX_EDIT_BYTES) {
    const fh = await fsp.open(abs, "r")
    try {
      const buf = Buffer.alloc(MAX_EDIT_BYTES)
      await fh.read(buf, 0, MAX_EDIT_BYTES, 0)
      return { content: buf.toString("utf-8"), size: st.size, truncated: true }
    } finally { await fh.close() }
  }
  const content = await fsp.readFile(abs, "utf-8")
  return { content, size: st.size, truncated: false }
}

export async function writeTextFile(abs: string, content: string): Promise<{ size: number }> {
  await fsp.writeFile(abs, content, "utf-8")
  const st = await fsp.stat(abs)
  return { size: st.size }
}

// ---- 递归搜索（文件名 + 内容；开关控制） ----
export interface SearchHit {
  rel: string
  abs: string
  isDir: boolean
  size: number
  mtime: string
  kind: string
  contentLine?: string // 内容命中行（内容搜索时）
}

export async function searchFiles(
  baseAbs: string,
  baseRel: string,
  opts: { keyword: string; recursive: boolean; content: boolean; maxResults?: number; onlyKinds?: string[] },
): Promise<{ hits: SearchHit[]; scanned: number; truncated: boolean }> {
  const max = opts.maxResults ?? 500
  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false
  const kw = opts.keyword.toLowerCase()

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 10 || scanned >= MAX_SEARCH_FILES) { if (depth > 10) return; return }
    let dirents
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of dirents) {
      if (scanned >= MAX_SEARCH_FILES || hits.length >= max) { truncated = true; return }
      if (d.name.startsWith(".stash")) continue
      scanned++
      const full = path.join(dir, d.name)
      const relPath = rel ? `${rel}/${d.name}` : d.name
      const kind = d.isDirectory() ? "dir" : kindOf(d.name)

      if (d.isDirectory()) {
        if (kw && d.name.toLowerCase().includes(kw)) {
          hits.push({ rel: relPath, abs: full, isDir: true, size: 0, mtime: "", kind: "dir" })
        }
        if (opts.recursive) await walk(full, relPath, depth + 1)
      } else {
        const nameMatch = kw && d.name.toLowerCase().includes(kw)
        let contentLine: string | undefined
        if (opts.content && !nameMatch && isTextFile(d.name)) {
          try {
            const st = await fsp.stat(full)
            if (st.size <= MAX_SEARCH_CONTENT_BYTES) {
              const text = await fsp.readFile(full, "utf-8")
              const line = text.split("\n").find((l) => l.toLowerCase().includes(kw))
              if (line) contentLine = line.trim().slice(0, 200)
            }
          } catch { /* skip */ }
        }
        if (nameMatch || contentLine) {
          let st
          try { st = await fsp.stat(full) } catch { continue }
          hits.push({ rel: relPath, abs: full, isDir: false, size: st.size, mtime: st.mtime.toISOString(), kind, contentLine })
        }
      }
    }
  }

  await walk(baseAbs, baseRel, 0)
  return { hits: hits.slice(0, max), scanned, truncated }
}

// ---- 归档 / 解压 ----
import { execFile } from "child_process"

function run(cmd: string, args: string[], timeoutMs = 120_000, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
    })
    child.on("error", () => resolve({ code: 1, stdout: "", stderr: "spawn error" }))
  })
}

/** 压缩：zip（可选密码 -P）；sourceAbs 可为文件或目录 */
export async function zipPaths(sourceAbsList: string[], destAbs: string, password?: string): Promise<{ ok: boolean; size: number; error?: string }> {
  const args = ["-r", "-q"]
  if (password) args.push("-P", password)
  args.push(destAbs)
  for (const src of sourceAbsList) {
    // 在源父目录内以相对名打包（保持结构）
    args.push(path.basename(src))
  }
  const cwd = path.dirname(sourceAbsList[0])
  const r = await run("zip", args, 180_000, cwd)
  if (r.code !== 0) return { ok: false, size: 0, error: r.stderr.slice(0, 300) || "zip 失败" }
  const st = await fsp.stat(destAbs).catch(() => null)
  return { ok: true, size: st?.size || 0 }
}

/** 解压：zip（密码）/ tar.gz / tar.bz2 / tar.xz / tgz */
export async function extractArchive(archiveAbs: string, destDir: string, password?: string): Promise<{ ok: boolean; error?: string; files?: number }> {
  const name = path.basename(archiveAbs).toLowerCase()
  await fsp.mkdir(destDir, { recursive: true })
  let r: { code: number; stderr: string; stdout: string }
  if (name.endsWith(".zip") || name.endsWith(".jar")) {
    const args = ["-o", archiveAbs, "-d", destDir]
    if (password) args.splice(1, 0, "-P", password)
    r = await run("unzip", args, 180_000)
  } else if (/\.(tar\.gz|tgz)$/.test(name)) {
    r = await run("tar", ["-xzf", archiveAbs, "-C", destDir], 180_000)
  } else if (/\.(tar\.bz2)$/.test(name)) {
    r = await run("tar", ["-xjf", archiveAbs, "-C", destDir], 180_000)
  } else if (/\.(tar\.xz)$/.test(name)) {
    r = await run("tar", ["-xJf", archiveAbs, "-C", destDir], 180_000)
  } else if (name.endsWith(".tar")) {
    r = await run("tar", ["-xf", archiveAbs, "-C", destDir], 180_000)
  } else if (name.endsWith(".gz") && !name.endsWith(".tar.gz")) {
    // 单文件 gunzip → 去掉 .gz 后缀
    const out = archiveAbs.slice(0, -3)
    r = await run("gunzip", ["-kf", archiveAbs], 60_000)
    if (r.code === 0 && out !== archiveAbs) {
      try { await fsp.rename(out, path.join(destDir, path.basename(out))) } catch { /* 同目录 */ }
    }
  } else {
    return { ok: false, error: "不支持的归档格式（支持 zip/tar/gz/bz2/xz）" }
  }
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) || "解压失败" }
  return { ok: true, files: undefined }
}

// ---- 删除（递归；软删入回收站由调用方决定登记 FileMeta 与否） ----
export async function removePath(abs: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fsp.rm(abs, { recursive: true, force: true }).then(() => ({ ok: true })).catch((e: Error) => ({ ok: false, error: e.message }))
  return r
}

// ---- 移动 / 复制 ----
export async function movePath(src: string, destDir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const dest = path.join(destDir, path.basename(src))
    if (path.resolve(dest) === path.resolve(src)) return { ok: false, error: "源与目标相同" }
    await fsp.rename(src, dest)
    return { ok: true }
  } catch (e) {
    // 跨设备 → 递归复制 + 删源
    try {
      await copyPath(src, path.join(destDir, path.basename(src)))
      await fsp.rm(src, { recursive: true, force: true })
      return { ok: true }
    } catch {
      return { ok: false, error: (e as Error).message }
    }
  }
}

export async function copyPath(src: string, destAbs: string): Promise<void> {
  const st = await fsp.stat(src)
  if (st.isDirectory()) {
    await fsp.mkdir(destAbs, { recursive: true })
    const items = await fsp.readdir(src)
    for (const item of items) {
      await copyPath(path.join(src, item), path.join(destAbs, item))
    }
  } else {
    await fsp.mkdir(path.dirname(destAbs), { recursive: true })
    await fsp.copyFile(src, destAbs)
  }
}

// ---- 图片/视频缩略图（ffmpeg scale 128px；图片 PNG/视频首帧） ----
export async function generateThumbnail(srcAbs: string, kind: "image" | "video"): Promise<{ ok: boolean; thumbAbs?: string; error?: string }> {
  const { tmpdir } = await import("os")
  const thumbAbs = path.join(tmpdir(), `dy-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
  const args = kind === "video"
    ? ["-ss", "0.5", "-i", srcAbs, "-frames:v", "1", "-vf", "scale=256:-2", "-q:v", "5", thumbAbs]
    : ["-i", srcAbs, "-vf", "scale=256:-2", "-frames:v", "1", "-q:v", "5", thumbAbs]
  const r = await run("ffmpeg", [...args, "-y"], 30_000)
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 200) }
  return { ok: true, thumbAbs }
}

// ---- 限速流（下载路由用；chunk 定时泄流） ----
export async function* throttledStream(
  readStream: AsyncIterable<Buffer>,
  kbPerSec: number,
): AsyncGenerator<Buffer> {
  if (!kbPerSec || kbPerSec <= 0) {
    for await (const chunk of readStream) yield chunk
    return
  }
  const budget = kbPerSec * 1024
  let windowBytes = budget
  const windowMs = 250
  let windowStart = Date.now()
  for await (const chunk of readStream) {
    let offset = 0
    while (offset < chunk.length) {
      const now = Date.now()
      if (now - windowStart >= windowMs) {
        windowStart = now
        windowBytes = budget
      }
      if (windowBytes <= 0) {
        await new Promise((r) => setTimeout(r, Math.max(5, windowMs - (Date.now() - windowStart))))
        continue
      }
      const take = Math.min(chunk.length - offset, windowBytes)
      windowBytes -= take
      offset += take
      yield chunk.subarray(offset - take, offset)
    }
  }
}

// ---- 文件读取异步迭代器（fs.createReadStream 的 web 兼容包装） ----
export async function* readChunks(abs: string, chunkSize = 64 * 1024): AsyncGenerator<Buffer> {
  const fh = await fsp.open(abs, "r")
  try {
    const buf = Buffer.alloc(chunkSize)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, null)
      if (bytesRead <= 0) break
      yield buf.subarray(0, bytesRead)
    }
  } finally {
    await fh.close()
  }
}

