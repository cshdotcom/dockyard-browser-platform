// QA r26：篡改检测结果验证
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const alert = await db.alert.findFirst({ where: { dedupeKey: { contains: "policy-tamper" } }, orderBy: { createdAt: "desc" } })
  console.log("告警:", alert ? `${alert.title} / ${alert.level}` : "无")
  const audit = await db.auditLog.findFirst({ where: { operationType: "POLICY_FILE_TAMPERED" }, orderBy: { createdAt: "desc" } })
  console.log("审计:", audit ? `${audit.operationType} / ${audit.severity}` : "无")
}
main().finally(() => db.$disconnect())
