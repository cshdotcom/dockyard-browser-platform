import { requireAdmin } from "@/lib/permissions"
import { PermissionsCenterPanel } from "./permissions-panel"

// ============================================================
// r31：权限中心 /admin/permissions
//   30 项权限锁三级分配矩阵（全局 / 用户组 / 用户）+ 搜索 + 沙箱级策略汇总深链
//   语义：锁死优先（用户 > 组任一命中 > 全局；ADMIN 对非查看类全局锁豁免；超管不受限）
// ============================================================

export const metadata = { title: "权限中心" }

export default async function PermissionsPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">权限中心</h1>
        <p className="text-sm text-muted-foreground mt-1">
          30 项细粒度权限锁的三级分配（全局 / 用户组 / 用户）与生效语义总览；沙箱级策略入口汇总
        </p>
      </div>
      <PermissionsCenterPanel />
    </div>
  )
}
