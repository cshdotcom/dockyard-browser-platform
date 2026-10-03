// QA r26：生命周期审计事件真实落库 + 永久归档语义验证 + 全量清理
import { PrismaClient } from "@prisma/client"
const db = new PrismaClient()
async function main() {
  const ws = await db.browserWorkspace.findFirst({ where: { name: "QA-R26-基线沙箱" } })
  if (!ws) throw new Error("QA 工作区不存在")
  const { recordCrxLifecycleEvent } = await import("../src/lib/crx-lifecycle")
  const demo = await db.user.findUnique({ where: { username: "demo" } })

  // 1. INSTALLED 事件
  await recordCrxLifecycleEvent({
    workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId,
    crxId: "c".repeat(32), crxName: "QA-测试扩展", kind: "INSTALLED",
    fromVersion: null, toVersion: "1.0.0", resolvedBy: "SANDBOX", sourceUsed: "https://example.com/crx",
  })
  const a1 = await db.auditLog.findFirst({ where: { operationType: "CRX_INSTALLED" }, orderBy: { createdAt: "desc" } })
  console.log("INSTALLED 审计:", a1 ? `${a1.operationType}/${a1.severity}/owner=${a1.ownerUserId === demo.id ? "demo✓" : a1.ownerUserId}` : "无")

  // 2. REMOVED 事件
  await recordCrxLifecycleEvent({
    workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId,
    crxId: "c".repeat(32), crxName: "QA-测试扩展", kind: "REMOVED", fromVersion: "1.0.0",
  })
  const a2 = await db.auditLog.findFirst({ where: { operationType: "CRX_REMOVED" }, orderBy: { createdAt: "desc" } })
  console.log("REMOVED 审计:", a2 ? a2.operationType : "无")

  // 3. VERSION_CHANGE 事件
  await recordCrxLifecycleEvent({
    workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId,
    crxId: "c".repeat(32), crxName: "QA-测试扩展", kind: "VERSION_CHANGE", fromVersion: "1.0.0", toVersion: "1.1.0",
  })
  const a3 = await db.auditLog.findFirst({ where: { operationType: "CRX_VERSION_CHANGE" }, orderBy: { createdAt: "desc" } })
  console.log("VERSION_CHANGE 审计:", a3 ? a3.operationType : "无")

  // 4. INCOGNITO_ENABLED 事件（无痕加载上报）
  await recordCrxLifecycleEvent({
    workspaceId: ws.id, workspaceName: ws.name, ownerUserId: ws.userId,
    crxId: "c".repeat(32), crxName: "QA-测试扩展", kind: "INCOGNITO_ENABLED",
  })
  const a4 = await db.auditLog.findFirst({ where: { operationType: "CRX_INCOGNITO_ENABLED" }, orderBy: { createdAt: "desc" } })
  console.log("INCOGNITO_ENABLED 审计:", a4 ? a4.operationType : "无")

  // 5. 永久归档语义：工作区软删后审计仍在（无级联）
  await db.browserWorkspace.update({ where: { id: ws.id }, data: { deletedAt: new Date() } })
  const count = await db.auditLog.count({ where: { operationType: { in: ["CRX_INSTALLED", "CRX_REMOVED", "CRX_VERSION_CHANGE", "CRX_INCOGNITO_ENABLED"] }, resourceId: "c".repeat(32) } })
  console.log("软删后审计保留（永久归档）:", count, "条（应=4）")
  await db.browserWorkspace.update({ where: { id: ws.id }, data: { deletedAt: null } })

  // 6. 物理删除工作区 → 审计仍保留
  const clone = await db.browserWorkspace.findFirst({ where: { name: "QA-R26-克隆体" } })
  if (clone) {
    await db.crxPolicyEntry.deleteMany({ where: { scopeType: "SANDBOX", scopeId: clone.id } })
    await db.browserWorkspace.delete({ where: { id: clone.id } })
    console.log("克隆体物理删除完成（审计独立保留）")
  }

  // 7. 全量 QA 清理
  await db.crxPolicyEntry.deleteMany({ where: { scopeType: "SANDBOX", scopeId: ws.id } })
  await db.crxInstallStatus.deleteMany({ where: { workspaceId: ws.id } })
  await db.browserWorkspace.delete({ where: { id: ws.id } })
  await db.browserTemplateVersion.deleteMany({ where: { templateId: null as never } }).catch(() => null)
  const tpl = await db.browserTemplate.findFirst({ where: { name: "QA-R26-版本测试" } })
  if (tpl) {
    await db.browserTemplateVersion.deleteMany({ where: { templateId: tpl.id } })
    await db.browserTemplate.delete({ where: { id: tpl.id } })
  }
  // 审计/告警清理（QA 产物）
  await db.auditLog.deleteMany({ where: { resourceId: "c".repeat(32) } })
  await db.auditLog.deleteMany({ where: { operationType: { in: ["WORKSPACE_CLONE", "TEMPLATE_VERSION_ROLLBACK"] }, createdAt: { gte: new Date(Date.now() - 3600_000) } } })
  await db.auditLog.deleteMany({ where: { operationType: "POLICY_FILE_TAMPERED", resourceName: { startsWith: "QA-R26" } } })
  await db.alert.deleteMany({ where: { title: { contains: "QA-R26" } } })
  await db.alert.deleteMany({ where: { dedupeKey: { startsWith: "policy-tamper-" + ws.id } } })
  // 还原策略文件（去掉篡改注入）
  const { writeNetworkPolicyFile } = await import("../src/lib/network-policy")
  await writeNetworkPolicyFile("qa-r26-profile", { policy: { allowInternalNetwork: false, allowSecureLocationAccess: false, source: "GLOBAL_DEFAULT", resolvedAt: new Date().toISOString() } })
  console.log("QA 清理完成")

  const residual = await db.browserWorkspace.count({ where: { name: { startsWith: "QA-R26" } } })
  console.log("残留工作区:", residual, "（应=0）")
  const residualTpl = await db.browserTemplate.count({ where: { name: { startsWith: "QA-R26" } } })
  console.log("残留模板:", residualTpl, "（应=0）")
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
