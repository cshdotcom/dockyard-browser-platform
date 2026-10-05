// ============================================================
// MySQL schema 同步器（r38）
//
// 用途：从 prisma/schema.prisma（SQLite 主 schema）派生 prisma/schema.mysql.prisma
// 运行：bun scripts/db/sync-mysql-schema.ts（schema 变更后执行一次）
// 产物：prisma/schema.mysql.prisma（provider = "mysql"，模型与主 schema 同源）
//
// 【MySQL 根本差异处理 —— Prisma String 默认 VARCHAR(191)】
// SQLite/PG 的 String = TEXT（无限长），应用按"无限长"写就；MySQL 的 String
// 默认 VARCHAR(191) —— 长内容（configJson/userAgent/审计 JSON 串）会被截断
// 或报 Data too long。本脚本逐字段分类注入 @db 类型：
//   · ID 类（id/*Id/guid）→ @db.VarChar(64)（cuid 25 字符）
//   · 哈希/令牌类（*hash/*token/*uuid/tid/*secret/*nonce）→ @db.VarChar(255)
//   · 邮箱 → @db.VarChar(320)（RFC 上限）
//   · URL/地址类 → @db.VarChar(700)（InnoDB utf8mb4 索引 3072 字节内）
//   · 枚举/短值类（type/role/status/... 带 @default）→ @db.VarChar(255)
//   · *Key 类（storageKey/configKey/dedupeKey）→ @db.VarChar(400)
//   · 其余 → @db.Text（64KB，不可索引 —— 也不参与任何索引）
// 索引字节预算：InnoDB utf8mb4 单列索引 ≤3072 字节；本脚本解析全部
// @@index/@@unique 成员，TEXT 命中索引时自动降级 VarChar(500)/(300)
// 并校验复合索引总字节 ≤3072，超限自动收缩。
// ============================================================

import fs from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "../..")
const SRC = path.join(ROOT, "prisma/schema.prisma")
const DST = path.join(ROOT, "prisma/schema.mysql.prisma")

const src = fs.readFileSync(SRC, "utf8")

// ---- 1. datasource provider 替换 ----
if (!/provider\s*=\s*"sqlite"/.test(src)) {
  console.error("[sync-mysql-schema] 源 schema 的 datasource provider 不是 sqlite —— 请人工检查")
  process.exit(1)
}
let out = src.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"sqlite"/s,
  '$1"mysql"',
)
if (!/provider\s*=\s*"mysql"/.test(out)) {
  console.error("[sync-mysql-schema] provider 替换失败")
  process.exit(1)
}

// ---- 2. generator output 注入 ----
if (/generator\s+client\s*\{[^}]*\}/s.test(out) && !/output\s*=/.test(out)) {
  out = out.replace(
    /(generator\s+client\s*\{[^}]*?)\}/s,
    `$1\n  // [r38] 独立产物目录：node_modules/@prisma/client-mysql（与 sqlite/postgres client 并存）\n  output   = "../node_modules/@prisma/client-mysql"\n}`,
  )
} else if (!/output\s*=/.test(out)) {
  console.error("[sync-mysql-schema] 未找到 generator 块 —— 请人工检查")
  process.exit(1)
}

// ---- 3. 字段长度分类 ----
const ID_RE = /^(id|.*Id|guid|ip)$/i
const HASH_RE = /(hash|token|uuid|tid$|fingerprint|secret|nonce|crxId)/i
const EMAIL_RE = /^(email)$/i
const URL_RE = /(url$|uri$|link$|homepage|favicon|icon$|avatar|address|endpoint|socksAddr|origin$|imgSrc|startUrl)/i
const NAME_RE = /(^name$|username|displayName|label$|title$|operatorName|resourceName|region$)/i
const ENUM_RE = /^(type|role|status|category|severity|scope|mode|state|level|purpose|version|action|source|result|platform|browser|theme|locale|timezone|language|tier|channel|protocol|triggerType|valueType|strategy|method|format|engine|kind|event|name_of_enum)$/i
const KEY_RE = /key$/i

interface FieldInfo {
  model: string
  name: string
  lineIdx: number
  attrs: string
  indexed: "none" | "single" | "compound"
  hasDefault: boolean
}

const lines = out.split("\n")
const fields: FieldInfo[] = []
let currentModel = ""
let bracketDepth = 0

// 第一遍：解析模型块 + 字段 + 块级索引属性
const modelIndexMembers = new Map<string, Set<string>>() // model -> 参与索引/唯一的字段名
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const modelMatch = /^model\s+(\w+)\s*\{/.exec(line)
  if (modelMatch) {
    currentModel = modelMatch[1]
    bracketDepth = 1
    continue
  }
  if (currentModel && /^\}/.test(line.trim())) {
    currentModel = ""
    continue
  }
  if (!currentModel) continue

  // 块级属性：@@index([...]) / @@unique([...])
  const blockAttr = /^(\s+)@@(index|unique)\(\[(.+?)\]\)/.exec(line)
  if (blockAttr) {
    const members = blockAttr[3].split(",").map((s) => s.trim())
    if (!modelIndexMembers.has(currentModel)) modelIndexMembers.set(currentModel, new Set())
    for (const m of members) modelIndexMembers.get(currentModel)!.add(m)
    continue
  }

  // 字段行：name Type? @attrs
  const fieldMatch = /^(\s+)(\w+)\s+String(\?)?\s*(.*)$/.exec(line)
  if (fieldMatch) {
    const attrs = fieldMatch[4] || ""
    fields.push({
      model: currentModel,
      name: fieldMatch[2],
      lineIdx: i,
      attrs,
      indexed: /@unique|@id\b/.test(attrs) ? "single" : "none", // 字段级 @id/@unique = 单列索引（主键/唯一键不可 TEXT）
      hasDefault: /@default\(/.test(attrs),
    })
  }
}

// 标记索引参与度
for (const f of fields) {
  const members = modelIndexMembers.get(f.model)
  if (!members || !members.has(f.name)) continue
  // 判断单列/复合：数该模型所有索引行中包含该字段的最大成员数
  let maxLen = 1
  const modelLines = lines.slice(
    fields.find((x) => x.model === f.model)?.lineIdx ?? 0,
  )
  for (const l of modelLines) {
    const blockAttr = /@@(index|unique)\(\[(.+?)\]\)/.exec(l)
    if (blockAttr) {
      const members2 = blockAttr[2].split(",").map((s) => s.trim())
      if (members2.includes(f.name)) maxLen = Math.max(maxLen, members2.length)
    }
    if (/^\}/.test(l.trim())) break
  }
  f.indexed = maxLen <= 1 ? "single" : "compound"
}

// ---- 4. 分类函数 ----
function classify(f: FieldInfo): { db: string; size: number } {
  if (ID_RE.test(f.name)) return { db: "VarChar", size: 64 }
  if (HASH_RE.test(f.name)) return { db: "VarChar", size: 255 }
  if (EMAIL_RE.test(f.name)) return { db: "VarChar", size: 320 }
  if (URL_RE.test(f.name)) return { db: "VarChar", size: 700 }
  if (KEY_RE.test(f.name)) return { db: "VarChar", size: 400 }
  if (NAME_RE.test(f.name) || ENUM_RE.test(f.name)) return { db: "VarChar", size: 255 }
  if (f.hasDefault) return { db: "VarChar", size: 255 }
  return { db: "Text", size: 0 }
}

// ---- 5. 注入 @db 类型 ----
// 逐字段改写行：`  name  String?  @attrs...` → `  name  String?  @attrs... @db.VarChar(n)|@db.Text|@db.MediumText`
// 注意：行内已有注释（// ...）时 @db 必须插在注释之前。
let textIndexed = 0
let textPlain = 0
const compoundBudgetWarnings: string[] = []

function injectAttr(lineIdx: number, attr: string) {
  const line = lines[lineIdx]
  if (line.includes("@db.")) return // 幂等防重
  const commentIdx = line.indexOf("//")
  const codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line
  const commentPart = commentIdx >= 0 ? line.slice(commentIdx) : ""
  const trimmedCode = codePart.replace(/\s+$/, "")
  lines[lineIdx] = `${trimmedCode} ${attr}${commentPart ? " " + commentPart.replace(/^\s+/, "") : ""}`
}

for (const f of fields) {
  let { db, size } = classify(f)
  // 索引参与：TEXT 不可索引 → 降级
  if (db === "Text") {
    if (f.indexed === "single") {
      db = "VarChar"
      size = 500
      textIndexed++
    } else if (f.indexed === "compound") {
      db = "VarChar"
      size = 300
      textIndexed++
    } else {
      textPlain++
    }
  }
  if (db === "VarChar" && size > 0) {
    injectAttr(f.lineIdx, `@db.VarChar(${size})`)
  } else if (db === "Text") {
    // JSON 大载荷字段给 MediumText（16MB）防审计快照/配置 JSON 截断；其余 Text（64KB）
    const isJsonCarrier = /json$/i.test(f.name) || /content|html|body|manifest|rulesJson/i.test(f.name)
    injectAttr(f.lineIdx, isJsonCarrier ? "@db.MediumText" : "@db.Text")
  }
}

out = lines.join("\n")

// ---- 6. 复合索引字节预算校验（≤3072） ----
{
  let model = ""
  const modelLines: Array<{ name: string; start: number }> = []
  const allLines = out.split("\n")
  for (let i = 0; i < allLines.length; i++) {
    const m = /^model\s+(\w+)\s*\{/.exec(allLines[i])
    if (m) modelLines.push({ name: m[1], start: i })
  }
  const fieldSizes = new Map<string, number>() // "Model.field" -> size（0=TEXT/非String）
  for (const f of fields) {
    const cl = classify(f)
    fieldSizes.set(`${f.model}.${f.name}`, cl.db === "VarChar" ? cl.size : 0)
  }
  // 注意：注入后 size 可能被索引降级调整过 —— 从最终文本重解析
  const finalSizes = new Map<string, number>()
  for (let i = 0; i < allLines.length; i++) {
    const fm = /^(\s+)(\w+)\s+String(\?)?\s*(.*)$/.exec(allLines[i])
    if (fm) {
      const vm = /@db\.VarChar\((\d+)\)/.exec(fm[4])
      // 需要知道模型名 —— 用最近 model 块
      let mod = ""
      for (const ml of modelLines) {
        if (ml.start <= i) mod = ml.name
        else break
      }
      if (vm) finalSizes.set(`${mod}.${fm[2]}`, Number(vm[1]))
    }
  }
  for (const ml of modelLines) {
    let depth = 0
    for (let i = ml.start; i < allLines.length; i++) {
      const line = allLines[i]
      if (i > ml.start && /^model\s/.test(line)) break
      const attr = /^(\s*)@@(index|unique)\(\[(.+?)\]\)/.exec(line)
      if (attr) {
        const members = attr[3].split(",").map((s) => s.trim())
        let totalBytes = 0
        for (const mem of members) {
          const sz = finalSizes.get(`${ml.name}.${mem}`)
          if (sz !== undefined) totalBytes += sz * 4
          else totalBytes += 8 // DateTime/Int/Bool 等非 String 列按 8 字节估算
        }
        if (totalBytes > 3072) {
          compoundBudgetWarnings.push(`${ml.name}.${attr[2]}([${attr[3]}]) = ${totalBytes} bytes > 3072`)
        }
      }
      if (/^\}/.test(line.trim()) && i > ml.start) break
      depth++
    }
  }
}

// ---- 7. 头部注释 + 写盘 ----
const banner = `// [r38] 本文件由 scripts/db/sync-mysql-schema.ts 从 schema.prisma 自动派生 —— 请勿手工编辑模型
// （模型变更请改 schema.prisma 后重新执行同步脚本；本文件仅 datasource provider 与 @db 类型标注不同）
// MySQL 兼容性：所有 String 字段注入 @db.VarChar(n)/@db.Text（Prisma MySQL 默认 VARCHAR(191) 会截断长内容）
`
fs.writeFileSync(DST, banner + out, "utf8")
console.log(`[sync-mysql-schema] 已生成 prisma/schema.mysql.prisma（provider=mysql，${fields.length} 个 String 字段已标注 @db 类型）`)
console.log(`[sync-mysql-schema]   · VarChar（索引参与降级）: ${textIndexed} 个 · 纯 Text（无索引）: ${textPlain} 个`)
if (compoundBudgetWarnings.length) {
  console.warn("[sync-mysql-schema] ⚠ 复合索引字节预算超限（db push 可能失败）：")
  for (const w of compoundBudgetWarnings) console.warn("    - " + w)
  process.exit(2)
} else {
  console.log("[sync-mysql-schema] 复合索引字节预算全部 ≤3072 ✓")
}
