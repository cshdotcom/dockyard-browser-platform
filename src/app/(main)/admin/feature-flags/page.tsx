import { db } from "@/lib/db"
import { requireAdmin } from "@/lib/permissions"
import { getConfig } from "@/lib/config"
import { FEATURE_FLAGS, FEATURE_FLAG_CATEGORIES, EFFECT_LABEL, type FeatureFlagDef } from "@/lib/feature-flags"
import { FeatureFlagsTable } from "./feature-flags-table"
import { ToggleLeft, Zap, ShieldCheck, Info } from "lucide-react"

// 功能开关（r27-f）：全平台特性治理一屏总览
// 读取 = 各键当前生效值（CONFIG_DEFAULTS 兜底）；写入 = setConfigAction（仅超管，
// 版本快照 + 审计 + 缓存刷新全链路复用），管理员可查看。
export const metadata = { title: "功能开关" }

export default async function FeatureFlagsPage() {
  const ctx = await requireAdmin()
  // 一次读齐全部开关键（getConfig 走内存缓存）
  const flags: Array<FeatureFlagDef & { current: boolean }> = []
  for (const f of FEATURE_FLAGS) {
    flags.push({ ...f, current: await getConfig<boolean>(f.key, f.default) })
  }
  // 最近一次配置变更（审计溯源展示）
  const lastChange = await db.auditLog.findFirst({
    where: { operationType: "CONFIG_UPDATE", resourceType: "CONFIG", resourceId: { in: FEATURE_FLAGS.map((f) => f.key) } },
    orderBy: { createdAt: "desc" },
    select: { resourceId: true, operatorName: true, createdAt: true, afterJson: true },
  })
  const onCount = flags.filter((f) => f.current).length
  const byCategory = FEATURE_FLAG_CATEGORIES.map((c) => ({
    category: c,
    flags: flags.filter((f) => f.category === c),
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">功能开关</h1>
          <p className="text-sm text-muted-foreground mt-1">
            企业级特性治理：全平台功能型开关一屏总览，切换即走版本快照 + 审计
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ToggleLeft className="h-4 w-4" />
          {onCount}/{flags.length} 已启用
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Zap className="h-4 w-4" />立即生效</div>
          <p className="text-2xl font-semibold tabular-nums mt-1">{flags.filter((f) => f.effect === "immediate").length}</p>
          <p className="text-xs text-muted-foreground mt-1">切换后下一个请求即生效</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" />会话级生效</div>
          <p className="text-2xl font-semibold tabular-nums mt-1">{flags.filter((f) => f.effect === "next-session").length}</p>
          <p className="text-xs text-muted-foreground mt-1">下次启动的沙箱应用新值</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Info className="h-4 w-4" />最近变更</div>
          {lastChange ? (
            <p className="text-sm mt-2 font-medium truncate">{lastChange.resourceId}</p>
          ) : (
            <p className="text-2xl font-semibold mt-1">—</p>
          )}
          {lastChange && (
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {lastChange.operatorName || "系统"} · {new Date(lastChange.createdAt).toLocaleString("zh-CN")}
            </p>
          )}
        </div>
      </div>

      <FeatureFlagsTable
        byCategory={byCategory.map((c) => ({
          category: c.category,
          flags: c.flags.map((f) => ({
            key: f.key, name: f.name, description: f.description, effect: f.effect,
            default: f.default, current: f.current,
          })),
        }))}
        canWrite={ctx.role === "SUPER_ADMIN"}
        effectLabel={EFFECT_LABEL}
      />
    </div>
  )
}
