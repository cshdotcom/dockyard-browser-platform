"use client"

// r24-c：VNC 控制端输入法切换器（作用域=当前沙箱）
// - 每沙箱独立 X 显示 + 独立 fcitx5 守护 → 切换只影响本沙箱，其他沙箱/在线用户互不影响
// - 引擎（拼音/双拼/五笔/日韩越…）与键盘布局（us/cn/jp/kr/de/fr…）两个维度
// - 偏好持久化：保存到工作区（沙箱重建后自动重新应用）
// - 无 fcitx5 组件 / 非内嵌形态：显示降级说明（键盘布局仍可用）

import * as React from "react"
import { toast } from "sonner"
import { Check, Languages, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { getWorkspaceImeAction, setWorkspaceImeAction, type WorkspaceImeStatus } from "@/server/actions/ime"

interface ImeSwitcherProps {
  workspaceId: string
  disabled?: boolean // 只读镜像/未连接时禁用
}

export function ImeSwitcher({ workspaceId, disabled }: ImeSwitcherProps) {
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState<WorkspaceImeStatus | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [applying, setApplying] = React.useState<string | null>(null)
  const [persist, setPersist] = React.useState(true)
  const [tab, setTab] = React.useState<"engine" | "layout">("engine")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await getWorkspaceImeAction({ workspaceId })
      if (res.code === 0 && res.data) {
        setStatus(res.data)
        if (res.data.reason?.includes("fcitx5") || !res.data.fcitx5Installed) setTab("layout")
      } else {
        toast.error(res.msg || "输入法状态加载失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "输入法状态加载失败")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    if (open && !status) void load()
  }, [open, status, load])

  const apply = async (kind: "engine" | "kbLayout", name: string) => {
    setApplying(name)
    try {
      const res = await setWorkspaceImeAction({ workspaceId, [kind]: name, persist })
      if (res.code === 0 && res.data) {
        toast.success(kind === "engine" ? `输入法已切换：${name}` : `键盘布局已切换：${name}${persist ? "（已保存偏好）" : ""}`)
        void load()
      } else {
        toast.error(res.msg || "切换失败")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "切换失败")
    } finally {
      setApplying(null)
    }
  }

  const engines = status?.engines ?? []
  const layouts = status?.layouts ?? []
  const currentEngine = status?.current.engine ?? null
  const currentLayout = status?.current.kbLayout ?? null

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v && status) void load() }}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-8" disabled={disabled} title="输入法（仅本沙箱，其他会话不受影响）" aria-label="切换输入法">
          <Languages className="h-3.5 w-3.5" />
          <span className="ml-1 hidden sm:inline text-xs">
            {currentEngine ? (engines.find((e) => e.name === currentEngine)?.label || currentEngine) : currentLayout ? currentLayout.toUpperCase() : "输入法"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Languages className="h-3.5 w-3.5 text-teal-600" />
            <span className="text-sm font-medium">沙箱输入法</span>
            <Badge variant="outline" className="text-[10px]">作用域=本沙箱</Badge>
          </div>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => void load()} aria-label="刷新输入法状态">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>
        </div>

        {status?.reason && (
          <div className="border-b bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {status.reason}
          </div>
        )}

        {/* 维度切换 */}
        <div className="flex border-b">
          {(["engine", "layout"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                tab === t ? "border-b-2 border-teal-600 text-teal-700 dark:text-teal-400" : "text-muted-foreground hover:text-foreground"
              )}
              disabled={t === "engine" && !status?.fcitx5Installed}
              aria-label={t === "engine" ? "输入法引擎列表" : "键盘布局列表"}
            >
              {t === "engine" ? `输入法引擎${engines.length ? `（${engines.length}）` : ""}` : `键盘布局${layouts.length ? `（${layouts.length}）` : ""}`}
            </button>
          ))}
        </div>

        {loading && !status ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> 加载输入法状态…
          </div>
        ) : tab === "engine" ? (
          <ScrollArea className="h-64">
            <div className="divide-y">
              {engines.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  容器未安装 fcitx5 输入法组件<br />（镜像需含 fcitx5 全家桶；键盘布局仍可用）
                </div>
              )}
              {engines.map((e) => (
                <button
                  key={e.name}
                  onClick={() => void apply("engine", e.name)}
                  disabled={applying !== null}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground w-28 truncate">{e.name}</span>
                    <span className={cn("text-sm", currentEngine === e.name && "font-medium text-teal-700 dark:text-teal-400")}>{e.label}</span>
                  </span>
                  {applying === e.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : currentEngine === e.name ? (
                    <Check className="h-3.5 w-3.5 text-teal-600" />
                  ) : null}
                </button>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <ScrollArea className="h-64">
            <div className="grid grid-cols-2 divide-x">
              {layouts.map((l) => (
                <button
                  key={l.name}
                  onClick={() => void apply("kbLayout", l.name)}
                  disabled={applying !== null}
                  className="flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={cn("font-mono text-xs", currentLayout === l.name && "text-teal-700 dark:text-teal-400")}>{l.name}</span>
                    <span className="text-xs text-muted-foreground truncate">{l.label}</span>
                  </span>
                  {applying === l.name ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : currentLayout === l.name ? (
                    <Check className="h-3.5 w-3.5 text-teal-600" />
                  ) : null}
                </button>
              ))}
              {layouts.length === 0 && (
                <div className="col-span-2 px-3 py-6 text-center text-xs text-muted-foreground">未取到键盘布局清单</div>
              )}
            </div>
          </ScrollArea>
        )}

        <div className="flex items-center justify-between border-t px-3 py-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <Switch checked={persist} onCheckedChange={setPersist} aria-label="保存为偏好" />
            保存为偏好（重建后自动应用）
          </label>
          <span className="text-[10px] text-muted-foreground">当前：{currentEngine || "默认"} · {currentLayout || "默认"}</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
