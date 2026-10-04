import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
// 种子 alert.emailRules 配置（空规则=按全局级别；写入一条示例规则后回退清空）
const before = await db.systemConfig.findUnique({ where: { key: "alert.emailRules" } })
console.log("existing rule config:", before?.value ?? "(not present, using default [])")
// 规则解析逻辑冒烟（与 alerts.ts 同构）
const parse = (raw) => {
  try {
    const arr = JSON.parse(raw || "[]")
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
const rules = [
  { id: "r1", name: "磁盘告警", enabled: true, matchField: "title", keyword: "磁盘", minLevel: "ERROR" },
  { id: "r2", name: "抑制磁盘", enabled: false, matchField: "title", keyword: "磁盘水位", minLevel: "ERROR" },
]
console.log("parse ok:", parse(JSON.stringify(rules)).length === 2)
console.log("parse broken:", parse("not-json{").length === 0)
await db.$disconnect()
