// QA 23-d 辅助：为 admin 插入一条已撤销信任的设备记录（验证 devices-table 删除记录按钮；删除后自动清理）
import { db } from "../src/lib/db"
async function main() {
  const admin = await db.user.findUnique({ where: { username: "admin" }, select: { id: true } })
  if (!admin) throw new Error("admin 不存在")
  const existing = await db.trustedDevice.findFirst({ where: { userId: admin.id, deviceId: "qa23d-test-device" } })
  if (existing) { console.log("已存在:", existing.id); process.exit(0) }
  const d = await db.trustedDevice.create({
    data: {
      userId: admin.id,
      deviceId: "qa23d-test-device",
      label: "QA23D 测试旧设备",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0",
      ip: "192.0.2.50",
      expiresAt: new Date(Date.now() + 86400_000),
      revokedAt: new Date(Date.now() - 3600_000),
      lastUsedAt: new Date(Date.now() - 7200_000),
    },
  })
  console.log("created:", d.id)
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1) })
