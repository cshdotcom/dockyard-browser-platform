import { db } from "@/lib/db"
import { getConfigBool } from "@/lib/config"
import { PlaygroundConsole } from "./playground-console"

// ============================================================
// r37：Playground（沙箱 CDP 试验场）
// 用途：对自己的沙箱执行 CDP 级操作（连接测试/JS 执行/截图/打印/目标列表）
// 并实时查看结果 —— 链路健康自检 + 脚本片段调试 + 自动化预演。
// ============================================================

export const dynamic = "force-dynamic"
export const metadata = { title: "Playground · Dockyard" }

export default async function PlaygroundPage() {
  const enabled = await getConfigBool("feature.playground", true)

  // 我的沙箱候选（双模式、非销毁；运行态标记用于引导）
  const workspaces = await db.browserWorkspace.findMany({
    where: { deletedAt: null, status: { not: "DESTROYED" } },
    select: { id: true, name: true, status: true, mode: true, cdpUrl: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Playground（沙箱试验场）</h1>
        <p className="text-sm text-muted-foreground mt-1">
          对你的浏览器沙箱执行 CDP 级操作并实时查看结果：连接健康测试、页面 JS 执行、
          截图预览、远程打印渲染、目标列表。CDP 与 VNC 双模式沙箱均可用。
        </p>
      </div>
      <PlaygroundConsole enabled={enabled} workspaces={workspaces} />
    </div>
  )
}
