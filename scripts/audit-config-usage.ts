// r23：扫描 CONFIG_DEFAULTS 中哪些键在代码里没有实际读取点（保存了但未生效）
import * as fs from "fs"
import * as path from "path"

const configSrc = fs.readFileSync("src/lib/config.ts", "utf8")
const keys = [...configSrc.matchAll(/"([a-z]+\.[a-zA-Z0-9]+)":\s*\{/g)].map((m) => m[1])

// 收集 src/ 与 mini-services/ 下全部 ts/tsx 源码
const sources: string[] = []
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue
      walk(p)
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      sources.push(fs.readFileSync(p, "utf8"))
    }
  }
}
walk("src")
const all = sources.join("\n")

const unused: string[] = []
for (const k of keys) {
  // 出现次数：config.ts 定义1次；其他出现 = 有读取点
  const count = (all.match(new RegExp(k.replace(/\./g, "\\."), "g")) || []).length
  if (count <= 1) unused.push(k)
}
console.log(`总配置键 ${keys.length}，未发现读取点 ${unused.length}：`)
for (const k of unused) console.log("  -", k)
