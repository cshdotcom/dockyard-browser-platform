/**
 * r28 冒烟：文件管理器核心库
 * 覆盖：域解析穿越防护 / 写保护 / 排序分页 / 文本读写 / zip 密码压缩解压
 *      / tar.gz 解压 / 搜索（递归+内容） / 移动复制 / 删除 / 限速流语义
 */
import { promises as fsp } from "fs"
import path from "path"
import { randomBytes } from "crypto"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

async function main() {
  console.log("== r28 冒烟：文件管理器核心 ==")
  const {
    resolveDomainPath, isWriteDenied, listDir, readTextFile, writeTextFile,
    zipPaths, extractArchive, removePath, movePath, copyPath, searchFiles, kindOf, throttledStream, readChunks,
  } = await import("../src/lib/file-explorer")

  const base = "/tmp/dy-r28-test-" + randomBytes(4).toString("hex")
  await fsp.mkdir(path.join(base, "sub", "deep"), { recursive: true })
  await fsp.mkdir(path.join(base, "empty"), { recursive: true })
  await fsp.writeFile(path.join(base, "readme.md"), "# Title\n\ncontent line with **bold**\n")
  await fsp.writeFile(path.join(base, "sub", "data.txt"), "hello needle-xyz world\nsecond line\n")
  await fsp.writeFile(path.join(base, "sub", "deep", "note.txt"), "deep needle-xyz file\n")
  await fsp.writeFile(path.join(base, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
  await fsp.writeFile(path.join(base, "sub", "tool.exe"), Buffer.from([0x4d, 0x5a, 1, 2]))

  const roots = { ROOT_FS: "/", STORAGE: "/tmp", HOME: base }

  // 1. 域解析与穿越
  check("resolve 正常路径", resolveDomainPath(roots, "HOME", "sub/data.txt").ok)
  check("resolve 穿越拒绝（../..）", !resolveDomainPath(roots, "HOME", "../../../etc/passwd").ok)
  check("resolve 绝对路径注入拒绝", !resolveDomainPath(roots, "STORAGE", "/etc").ok)
  check("resolve 根自身 ok", resolveDomainPath(roots, "HOME", ".").ok)

  // 2. 写保护
  check("ROOT_FS /proc 拒写", isWriteDenied("ROOT_FS", "/proc/1/mem", "/tmp"))
  check("ROOT_FS /etc 拒写", isWriteDenied("ROOT_FS", "/etc/passwd", "/tmp"))
  check("ROOT_FS 普通目录可写", !isWriteDenied("ROOT_FS", "/opt/data", "/tmp"))
  check("STORAGE system 拒写", isWriteDenied("STORAGE", "/tmp/system/ledger.json", "/tmp"))
  check("STORAGE profiles 拒写", isWriteDenied("STORAGE", "/tmp/profiles/u1/p1", "/tmp"))

  // 3. 类型识别
  check("kind png=image", kindOf("a.png") === "image")
  check("kind md=text", kindOf("a.md") === "text")
  check("kind zip=archive", kindOf("a.zip") === "archive")
  check("kind tar.gz=archive", kindOf("a.tar.gz") === "archive")
  check("kind unknown=binary", kindOf("a.xyz") === "binary")

  // 4. 列表：排序+分页
  const ls = await listDir(base, { page: 1, pageSize: 3, sortBy: "name" })
  check("分页 total>=4", ls.total >= 4, "total=" + ls.total)
  check("分页截取 3 条", ls.entries.length === 3)
  const lsDesc = await listDir(base, { page: 1, pageSize: 50, sortBy: "name", sortDir: "desc" })
  check("倒序第一个 > 正序第一个（名称）", lsDesc.entries[0].name > ls.entries[0].name)
  const lsKw = await listDir(base, { page: 1, pageSize: 50, keyword: "readme" })
  check("关键词过滤", lsKw.total === 1 && lsKw.entries[0].name === "readme.md")
  const lsEmpty = await listDir(path.join(base, "empty"), { page: 1, pageSize: 10 })
  check("空目录", lsEmpty.total === 0)
  check("不存在目录容错", (await listDir("/tmp/nonexist-dy-" + randomBytes(3).toString("hex"), { page: 1, pageSize: 10 })).total === 0)

  // 5. 文本读写
  const tr = await readTextFile(path.join(base, "readme.md"), "readme.md")
  check("文本读取", tr.content.includes("# Title"))
  await writeTextFile(path.join(base, "new.txt"), "写入测试")
  check("文本写入+回读", (await fsp.readFile(path.join(base, "new.txt"), "utf-8")) === "写入测试")

  // 6. zip 密码压缩 + 解压
  const zipPath = path.join(base, "pack.zip")
  const zr = await zipPaths([path.join(base, "readme.md"), path.join(base, "sub")], zipPath, "secret123")
  check("zip 密码压缩", zr.ok && zr.size > 100, JSON.stringify(zr))
  const exDir = path.join(base, "unzipped")
  const exBad = await extractArchive(zipPath, exDir, "wrongpass")
  check("错误密码解压失败", !exBad.ok)
  const exOk = await extractArchive(zipPath, exDir, "secret123")
  check("正确密码解压", exOk.ok && (await fsp.readFile(path.join(exDir, "readme.md"), "utf-8")).includes("# Title"))

  // 7. tar.gz
  await fsp.mkdir(path.join(base, "tardir"), { recursive: true })
  await fsp.writeFile(path.join(base, "tardir", "x.txt"), "tar content")
  const { execFile } = await import("child_process")
  await new Promise<void>((res) => execFile("tar", ["-czf", path.join(base, "t.tar.gz"), "-C", base, "tardir"], () => res()))
  const extDir = path.join(base, "tarout")
  const tr2 = await extractArchive(path.join(base, "t.tar.gz"), extDir)
  check("tar.gz 解压", tr2.ok && (await fsp.readFile(path.join(extDir, "tardir", "x.txt"), "utf-8")) === "tar content")

  // 8. 搜索
  const s1 = await searchFiles(base, "", { keyword: "needle-xyz", recursive: true, content: false })
  check("递归文件名搜索 0（内容未开）", s1.hits.length === 0)
  const s2 = await searchFiles(base, "", { keyword: "needle-xyz", recursive: true, content: true })
  check("内容搜索命中 4（含解压副本）", s2.hits.length === 4, "hits=" + s2.hits.length)
  const s3 = await searchFiles(path.join(base, "sub"), "sub", { keyword: "note", recursive: false, content: false })
  check("非递归目录不命中深层", s3.hits.length === 0)
  const s4 = await searchFiles(path.join(base, "sub"), "sub", { keyword: "note", recursive: true, content: false })
  check("递归命中深层", s4.hits.length === 1)
  const s5 = await searchFiles(base, "", { keyword: "exe", recursive: true, content: false })
  check("文件名 exe 命中（含内容不匹配工具目录）", s5.hits.some((h) => h.rel.endsWith("tool.exe")))

  // 9. 移动 / 复制 / 删除
  await movePath(path.join(base, "new.txt"), path.join(base, "sub"))
  check("移动后原位不存在", !(await fsp.stat(path.join(base, "new.txt")).catch(() => null)) && !!(await fsp.stat(path.join(base, "sub", "new.txt")).catch(() => null))?.isFile())
  await copyPath(path.join(base, "sub", "new.txt"), path.join(base, "copy.txt"))
  check("复制存在", !!(await fsp.stat(path.join(base, "copy.txt")).catch(() => null))?.isFile())
  const rm = await removePath(path.join(base, "copy.txt"))
  check("删除文件", rm.ok && !(await fsp.stat(path.join(base, "copy.txt")).catch(() => null)))
  const rmDir = await removePath(path.join(base, "unzipped"))
  check("删除目录（递归）", rmDir.ok && !(await fsp.stat(path.join(base, "unzipped")).catch(() => null)))

  // 10. 限速流语义（小数据 + 高速限速，验证全量通过）
  const src = path.join(base, "readme.md")
  const chunks: Buffer[] = []
  for await (const c of throttledStream(readChunks(src, 1024), 1024 * 1024)) chunks.push(Buffer.from(c))
  const joined = Buffer.concat(chunks).toString("utf-8")
  check("限速流完整透传", joined.includes("# Title"))

  // 清理
  await fsp.rm(base, { recursive: true, force: true })
  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
