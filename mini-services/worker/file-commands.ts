// r29-f：Worker 分布式文件存储节点通道（主控指令驱动；纯执行无自主决策）
// 命令：file.put（base64 + sha256 完整性校验）/ file.status / file.delete
// r36 新增：backup.replica.begin / append / finish（大文件分块落盘 + 整体 sha256 收口）
//            —— 备份多节点副本推送通道（指令按顺序到达；临时分片写 .part 后原子改名）
// 安全：fileKey 白名单（单层 [A-Za-z0-9_.-] 或 backups/<name> 前缀；路径穿越拒绝）

import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, appendFileSync, renameSync, readFileSync } from "fs"
import { createHash } from "crypto"
import { join, dirname } from "path"

export const workerDfsDir = (): string => process.env.WORKER_DFS_DIR || join(process.cwd(), "dfs-store")

// r36：白名单扩展（单层键保持兼容 + backups/<name> 单层目录前缀；拒绝 ../ 与多层路径）
function dfsPath(fileKey: string): string | null {
  if (/^[A-Za-z0-9_.-]{1,128}$/.test(fileKey)) return join(workerDfsDir(), fileKey)
  if (/^backups\/[A-Za-z0-9_.-]{1,120}$/.test(fileKey)) return join(workerDfsDir(), fileKey)
  return null
}

interface ChunkPayload {
  fileKey?: string
  sizeBytes?: number
  sha256?: string // 整体校验（begin 声明 / finish 验证）
  offset?: number // append 偏移
  contentB64?: string // append 内容
  chunkSha256?: string // append 分片校验
}

export async function handleFileCommand(cmd: string, payload: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const p = (payload || {}) as { fileKey?: string; contentB64?: string; sha256?: string }
  if (!p.fileKey) return { ok: false, error: "缺少 fileKey" }
  const target = dfsPath(p.fileKey)
  if (!target) return { ok: false, error: "fileKey 非法（路径穿越拒绝）" }
  try {
    if (cmd === "file.put") {
      if (!p.contentB64) return { ok: false, error: "缺少 contentB64" }
      mkdirSync(dirname(target), { recursive: true })
      const buf = Buffer.from(p.contentB64, "base64")
      writeFileSync(target, buf)
      if (p.sha256) {
        const actual = createHash("sha256").update(buf).digest("hex")
        if (actual !== p.sha256) { unlinkSync(target); return { ok: false, error: `sha256 不匹配（期望 ${p.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）` } }
      }
      return { ok: true, data: { fileKey: p.fileKey, sizeBytes: buf.length } }
    }
    if (cmd === "file.status") {
      if (!existsSync(target)) return { ok: true, data: { exists: false } }
      const st = statSync(target)
      return { ok: true, data: { exists: true, sizeBytes: st.size, mtimeMs: st.mtimeMs } }
    }
    if (cmd === "file.delete") {
      if (existsSync(target)) unlinkSync(target)
      return { ok: true }
    }
    // ---- r36：备份副本分块写入（begin → append* → finish 原子收口）----
    if (cmd === "backup.replica.begin" || cmd === "file.chunk.begin") {
      const cp = payload as ChunkPayload
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target + ".part", Buffer.alloc(0)) // 分片临时文件（同名原子改名落位）
      return { ok: true, data: { fileKey: p.fileKey, expectBytes: cp.sizeBytes ?? 0 } }
    }
    if (cmd === "backup.replica.append" || cmd === "file.chunk.append") {
      const cp = payload as ChunkPayload
      if (!cp.contentB64) return { ok: false, error: "缺少 contentB64" }
      const buf = Buffer.from(cp.contentB64, "base64")
      if (cp.chunkSha256) {
        const actual = createHash("sha256").update(buf).digest("hex")
        if (actual !== cp.chunkSha256) return { ok: false, error: `分片 sha256 不匹配（offset=${cp.offset ?? "?"}）` }
      }
      appendFileSync(target + ".part", buf)
      return { ok: true, data: { fileKey: p.fileKey, appended: buf.length, total: statSync(target + ".part").size } }
    }
    if (cmd === "backup.replica.finish" || cmd === "file.chunk.finish") {
      const cp = payload as ChunkPayload
      if (!existsSync(target + ".part")) return { ok: false, error: "分片临时文件不存在（begin 未执行或已收口）" }
      // 整体校验（分块传输完整性收口；失败即删除分片，不留半文件）
      if (cp.sha256) {
        const partSize = statSync(target + ".part").size
        if (partSize > 256 * 1024 * 1024) {
          return { ok: false, error: `分片过大（${partSize} 字节 > 256MB 上限；平台整库备份不应超过该规模）` }
        }
        const actual = createHash("sha256").update(readFileSync(target + ".part")).digest("hex")
        if (actual !== cp.sha256) { unlinkSync(target + ".part"); return { ok: false, error: `整体 sha256 不匹配（期望 ${cp.sha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…）` } }
      }
      renameSync(target + ".part", target) // 原子落位（读侧永不看到半文件）
      return { ok: true, data: { fileKey: p.fileKey, sizeBytes: statSync(target).size } }
    }
    return { ok: false, error: `未知文件指令 ${cmd}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
