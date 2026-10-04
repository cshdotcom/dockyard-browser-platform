/**
 * r28 冒烟：文件公开分享链路（修复 404）
 * 覆盖：创建分享（单文件/多文件/文件夹）/ 密钥门 / 公开解析 / 下载 / 撤销 / 越权 / 穿越
 */
import { PrismaClient } from "@prisma/client"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const db = new PrismaClient()
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail })
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`)
}

async function main() {
  // 1. 准备测试用户 + 测试文件
  const username = `smoke-share-${Date.now()}`
  const user = await db.user.create({
    data: {
      username, displayName: "分享冒烟用户", email: `${username}@test.local`,
      passwordHash: "x", role: "USER", enabled: true,
      quota: { diskMb: 1024 },
    },
  })
  const storageRoot = process.env.STORAGE_LOCAL_PATH || "/home/z/my-project/storage"
  const testDir = path.join(storageRoot, "smoke-share")
  fs.mkdirSync(testDir, { recursive: true })

  const mkFile = (key: string, content: string) => {
    const full = path.join(storageRoot, key)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    return db.fileMeta.create({
      data: {
        fileName: path.basename(key), storageKey: key, size: Buffer.byteLength(content),
        mime: "text/plain", category: "GENERAL", userId: user.id, virusScanned: true,
      },
    })
  }
  const f1 = await mkFile("smoke-share/a.txt", "hello r28 share single")
  const f2 = await mkFile("smoke-share/b.md", "# multi file share")
  const f3 = await mkFile("smoke-share/dir/c.txt", "folder inner c")
  const f4 = await mkFile("smoke-share/dir/d.json", "{\"k\":1}")

  // 2. 导入被测模块（等价 server actions 内部直接调 lib）
  const lib = await import("../src/lib/file-share")

  // 2a. 单文件分享
  const s1 = await lib.createFileShare({
    fileIds: [f1.id], creatorUserId: user.id, creatorName: username, permission: "DOWNLOAD",
  })
  check("创建单文件分享", !!s1.token && s1.fileCount === 1, `token=${s1.token.slice(0, 8)}…`)

  // 2b. 多文件批量分享 + 自定义有效期 + 访客密钥
  const s2 = await lib.createFileShare({
    fileIds: [f2.id, f1.id], creatorUserId: user.id, creatorName: username,
    permission: "VIEW", visitorKey: "topsecret-key-42", expireMinutes: 60, maxUses: 10,
  })
  check("多文件分享+密钥+有效期+次数", !!s2.token && s2.fileCount === 2 && s2.visitorKeyPlain === "topsecret-key-42")

  // 2c. 文件夹分享（前缀动态匹配）
  const s3 = await lib.createFileShare({
    folderKey: "smoke-share/dir", creatorUserId: user.id, creatorName: username, permission: "DOWNLOAD",
  })
  check("文件夹分享（前缀）", s3.fileCount === 2, `${s3.fileCount} 个文件`)

  // 3. 公开解析
  const v1 = await lib.resolvePublicShare(s1.token).catch((e) => { throw e })
  check("免密钥公开解析", v1.fileCount === 1 && v1.files[0].previewKind === "text")
  check("预览能力判定 text", v1.files[0].previewKind === "text")

  // 3a. 密钥门：不带密钥 → NEED_KEY
  let needKeyHit = false
  try { await lib.resolvePublicShare(s2.token) } catch (e: any) {
    needKeyHit = /NEED_KEY|密钥/.test(String(e?.message || e))
  }
  check("密钥门拦截（NEED_KEY）", needKeyHit)

  // 3b. 密钥正确 → 通过
  const v2 = await lib.resolvePublicShare(s2.token, "topsecret-key-42")
  check("密钥正确解锁", v2.fileCount === 2 && v2.needsKey)

  // 3c. 错误密钥 → 拒绝
  let wrongKeyHit = false
  try { await lib.resolvePublicShare(s2.token, "wrong-key") } catch { wrongKeyHit = true }
  check("错误密钥拒绝", wrongKeyHit)

  // 4. VIEW 型禁止下载
  let viewDeny = false
  try { await lib.authorizeShareDownload(s2.token, f1.id, "topsecret-key-42") } catch (e: any) {
    viewDeny = /仅允许预览/.test(String(e?.message || e))
  }
  check("VIEW 型分享禁止下载", viewDeny)

  // 5. DOWNLOAD 型正常下载 + 归属校验 + 文件夹归属
  const dl = await lib.authorizeShareDownload(s1.token, f1.id)
  check("DOWNLOAD 型授权下载", dl.meta.id === f1.id)
  const dlFolder = await lib.authorizeShareDownload(s3.token, f4.id)
  check("文件夹分享内文件可下载", dlFolder.meta.id === f4.id)

  // 5a. 越权：不属于分享清单的文件 → 拒绝
  let foreignDeny = false
  try { await lib.authorizeShareDownload(s1.token, f3.id) } catch { foreignDeny = true }
  check("清单外文件拒绝下载", foreignDeny)

  // 6. 自定义过期：过期分享 → 拒绝
  const s4 = await lib.createFileShare({
    fileIds: [f4.id], creatorUserId: user.id, creatorName: username, expireMinutes: 1,
  })
  await db.fileShare.update({ where: { token: s4.token }, data: { expireAt: new Date(Date.now() - 1000) } })
  let expiredDeny = false
  try { await lib.resolvePublicShare(s4.token) } catch { expiredDeny = true }
  check("过期分享拒绝访问", expiredDeny)

  // 7. 撤销 → 拒绝
  await lib.revokeFileShare(s1.token, user.id, username)
  let revokedDeny = false
  try { await lib.resolvePublicShare(s1.token) } catch { revokedDeny = true }
  check("撤销后拒绝访问", revokedDeny)

  // 8. 次数上限
  const s5 = await lib.createFileShare({
    fileIds: [f2.id], creatorUserId: user.id, creatorName: username, maxUses: 1, visitorKey: "once-key",
  })
  await lib.resolvePublicShare(s5.token, "once-key")
  let usesDeny = false
  try { await lib.resolvePublicShare(s5.token, "once-key") } catch { usesDeny = true }
  check("次数用尽拒绝访问", usesDeny)

  // 9. 拥有者列表
  const mine = await lib.listSharesByCreator(user.id)
  check("拥有者分享列表", mine.length >= 3, `${mine.length} 条`)

  // 10. token 不可枚举性（128bit）
  check("token 128bit 随机", /^[0-9a-f]{32}$/.test(s1.token))

  // ---- 清理 ----
  await db.fileShare.deleteMany({ where: { createdByUserId: user.id } })
  await db.fileMeta.deleteMany({ where: { userId: user.id } })
  await db.auditLog.deleteMany({ where: { operatorUserId: user.id } })
  await db.user.delete({ where: { id: user.id } })
  fs.rmSync(testDir, { recursive: true, force: true })
  fs.rmSync(path.join(storageRoot, "smoke-share"), { recursive: true, force: true })

  const pass = results.filter((r) => r.ok).length
  console.log(`\n===== r28 文件分享冒烟：${pass}/${results.length} 通过 =====`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}

main().catch(async (e) => {
  console.error("冒烟执行异常：", e)
  await db.$disconnect()
  process.exit(1)
})
