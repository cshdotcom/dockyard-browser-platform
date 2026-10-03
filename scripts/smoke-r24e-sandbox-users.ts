// r24-e 沙箱专属 Linux 用户测试（开发环境非 root：命名规则 + 台账读写 + 降级语义）
// root 形态的 useradd/UID 复活在生产容器内执行（此处验证可验证的全部逻辑）
import { sandboxLinuxUserName, sandboxUserLedgerInfo } from "../src/lib/embedded-sandbox"

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

// 1. 命名规则
console.log("【1】沙箱专属用户命名（dyu-<uuid8>-<uname6>）")
const LINUX_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const cases: [string, string, string][] = [
  ["cld9k2x4m7n8p3q5r0s2", "zhangsan", "dyu-cld9k2x4-zhangs"],
  ["cld9k2x4m7n8p3q5r0s2", "Alice_W", "dyu-cld9k2x4-alicew"],
  ["cld9k2x4m7n8p3q5r0s2", "", "dyu-cld9k2x4-u"],
  ["ABC-123-XYZ", "UPPER", "dyu-abc123xy-upper"],
  ["c", "u", "dyu-c0000000-u"],
]
for (const [uuid, uname, expect] of cases) {
  const got = sandboxLinuxUserName(uuid, uname)
  ok(`命名 ${uuid.slice(0, 8)}/${uname} → ${expect}`, got === expect, got)
  ok(`  合法 Linux 用户名（≤32、字符集）`, LINUX_NAME_RE.test(got))
}
// 同一用户两个沙箱 → 两个不同账户（即使同名用户）
ok("同用户不同沙箱 = 不同账户", sandboxLinuxUserName("uuid-aaaa1111", "user") !== sandboxLinuxUserName("uuid-bbbb2222", "user"))
ok("同沙箱不同用户 = 不同账户", sandboxLinuxUserName("uuid-aaaa1111", "user1") !== sandboxLinuxUserName("uuid-aaaa1111", "user2"))

// 2. 台账读写（独立测试存储路径）
console.log("【2】UID 台账（storage/system/sandbox-users.json）")
process.env.STORAGE_LOCAL_PATH = "/tmp/dy-r24e-storage"
const fs = await import("fs")
fs.rmSync("/tmp/dy-r24e-storage", { recursive: true, force: true })
const info0 = await sandboxUserLedgerInfo()
ok("空台账 nextUid=20000（UID 池起点）", info0.nextUid === 20000, String(info0.nextUid))
ok("空台账用户数 0", info0.users.length === 0)

// 手工写入台账（模拟已有沙箱账户）→ 读回
fs.mkdirSync("/tmp/dy-r24e-storage/system", { recursive: true })
fs.writeFileSync("/tmp/dy-r24e-storage/system/sandbox-users.json", JSON.stringify({
  nextUid: 20003,
  users: {
    "dyu-cld9k2x4-zhangs": { uid: 20000, workspaceUuid: "cld9k2x4", owner: "zhangsan", createdAt: 1 },
    "dyu-aaaa1111-u": { uid: 20001, workspaceUuid: "aaaa1111", owner: "u", createdAt: 2 },
    "dyu-bbbb2222-lisi": { uid: 20002, workspaceUuid: "bbbb2222", owner: "lisi", createdAt: 3 },
  },
}, null, 1))
const info1 = await sandboxUserLedgerInfo()
ok("台账读回 3 个账户", info1.users.length === 3)
ok("UID 排序", info1.users.map((u) => u.uid).join(",") === "20000,20001,20002")
ok("映射字段完整", info1.users[0].name === "dyu-cld9k2x4-zhangs" && info1.users[0].owner === "zhangsan")
ok("alive=false（本环境无这些账户，非 root 无法创建）", info1.users.every((u) => !u.alive))

// 坏台账 → 回退空
fs.writeFileSync("/tmp/dy-r24e-storage/system/sandbox-users.json", "{broken json")
const info2 = await sandboxUserLedgerInfo()
ok("坏台账回退空（防半写损坏）", info2.users.length === 0 && info2.nextUid === 20000)
fs.rmSync("/tmp/dy-r24e-storage", { recursive: true, force: true })

// 3. 非 root 降级语义
console.log("【3】非 root 开发环境降级")
const { ensureSandboxLinuxUser } = await import("../src/lib/embedded-sandbox")
const r = await ensureSandboxLinuxUser("cld9k2x4", "zhangsan")
ok("非 root → null（同用户模式降级，进程链路不变）", r === null)

console.log(`\n结果：${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
