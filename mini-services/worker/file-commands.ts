// r29-f：Worker 分布式文件存储节点通道（主控指令驱动；纯执行无自主决策）
// 命令：file.put（base64 + sha256 完整性校验）/ file.status / file.delete
// 安全：fileKey 白名单 [A-Za-z0-9_.-]{1,128}（路径穿越拒绝）

import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "fs"
import { join } from "path"
import { createHash } from "crypto"

export const workerDfsDir = (): string => process.env.WORKER_DFS_DIR || join(process.cwd(), "dfs-store")

function dfsPath(fileKey: string): string | null {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(fileKey)) return null
  return join(workerDfsDir(), fileKey)
}

export async function handleFileCommand(cmd: string, payload: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const p = (payload || {}) as { fileKey?: string; contentB64?: string; sha256?: string }
  if (!p.fileKey) return { ok: false, error: "缺少 fileKey" }
  const target = dfsPath(p.fileKey)
  if (!target) return { ok: false, error: "fileKey 非法（路径穿越拒绝）" }
  try {
    if (cmd === "file.put") {
      if (!p.contentB64) return { ok: false, error: "缺少 contentB64" }
      mkdirSync(workerDfsDir(), { recursive: true })
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
    return { ok: false, error: `未知文件指令 ${cmd}` }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
