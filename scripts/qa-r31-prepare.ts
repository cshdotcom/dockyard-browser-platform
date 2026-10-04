// r31 QA 准备：写入分享测试文件 + 读取 admin/demo 用户 ID
import { PrismaClient } from "@prisma/client"
import { mkdir, writeFile } from "fs/promises"
import { join } from "path"

const db = new PrismaClient()
const admin = await db.user.findUnique({ where: { username: "admin" } })
const demo = await db.user.findUnique({ where: { username: "demo" } })
if (!admin) throw new Error("admin 不存在")

const home = join(process.env.STORAGE_LOCAL_PATH || "storage", "home", admin.id)
const dir = join(home, "QA-r31-分享目录")
const sub = join(dir, "子目录")
await mkdir(sub, { recursive: true })
await writeFile(join(dir, "说明.md"), "# QA 分享测试\n\n这是 r31 分享预览页验收文件。\n\n- 列表项 1\n- 列表项 2\n", "utf8")
await writeFile(join(dir, "notes.txt"), "r31 share test: notes.txt 中文内容 ✓ multi-language", "utf8")
await writeFile(join(sub, "nested.txt"), "nested file in subfolder", "utf8")

console.log(JSON.stringify({ adminId: admin.id, demoId: demo?.id || null, home, dir }))
await db.$disconnect()
