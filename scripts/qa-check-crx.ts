import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const entries = await db.crxPolicyEntry.findMany({ where: { deletedAt: null }, select: { scopeType: true, scopeId: true, crxId: true, note: true } })
  for (const e of entries) console.log(`scope=${e.scopeType}:${e.scopeId?.slice(0, 8)} crx=${e.crxId.slice(0, 8)} note=${e.note}`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
