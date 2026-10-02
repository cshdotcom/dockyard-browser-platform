"use client"

// 临时分享链接兑换面板（客户端）：由 shared/page.tsx 服务端完成登录门控后渲染。
//   · 打开即调用 redeemWorkspaceShareLinkAction：校验有效期/撤销/次数上限
//   · 兑换成功 → 自动绑定 WorkspaceShare（与普通共享一致）→ 引导跳转工作区详情
//   · 失败（过期/撤销/超限/不存在）→ 明确错误提示 + 返回列表

import * as React from "react"
import { useRouter } from "next/navigation"
import { Link2, Loader2, CheckCircle2, XCircle, Globe } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { redeemWorkspaceShareLinkAction } from "@/server/actions/workspaces"

type RedeemState =
  | { kind: "loading" }
  | { kind: "ok"; workspaceId: string; workspaceName: string; permission: string; already: boolean }
  | { kind: "error"; msg: string }

export function SharedRedeemPanel({ token }: { token: string }) {
  const router = useRouter()
  const [state, setState] = React.useState<RedeemState>({ kind: "loading" })

  React.useEffect(() => {
    if (!token) {
      setState({ kind: "error", msg: "缺少分享令牌（链接无效）" })
      return
    }
    let alive = true
    void (async () => {
      const res = await redeemWorkspaceShareLinkAction({ token })
      if (!alive) return
      if (res.code === 0) {
        setState({ kind: "ok", ...(res.data as { workspaceId: string; workspaceName: string; permission: string; already: boolean }) })
      } else {
        setState({ kind: "error", msg: res.msg })
      }
    })().catch((e) => {
      if (alive) setState({ kind: "error", msg: e instanceof Error ? e.message : "兑换失败" })
    })
    return () => { alive = false }
  }, [token])

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Link2 className="h-5 w-5 text-teal-600" />
            浏览器沙箱分享链接
          </CardTitle>
          <CardDescription>通过临时链接接入共享的浏览器工作区（仅已登录用户可兑换加入）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在校验分享链接…
            </div>
          )}
          {state.kind === "ok" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-teal-200 bg-teal-50/70 dark:bg-teal-950/30 dark:border-teal-800 p-3">
                <CheckCircle2 className="h-5 w-5 text-teal-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {state.already ? "你已拥有该工作区的共享授权" : "共享授权已开通"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    工作区「{state.workspaceName}」·{" "}
                    <Badge className={state.permission === "OPERATE" ? "bg-teal-600 hover:bg-teal-600" : ""}>
                      {state.permission === "OPERATE" ? "可操作（键鼠/剪贴板/CDP）" : "只读观看"}
                    </Badge>
                  </p>
                </div>
              </div>
              <Button className="w-full bg-teal-600 hover:bg-teal-700" onClick={() => router.push(`/workspaces/${state.workspaceId}`)}>
                <Globe className="mr-1 h-4 w-4" />
                进入工作区详情
              </Button>
              <Button variant="outline" className="w-full" onClick={() => router.push("/workspaces")}>
                返回工作区列表
              </Button>
            </div>
          )}
          {state.kind === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/70 dark:bg-red-950/30 dark:border-red-800 p-3">
                <XCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">链接无法使用</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{state.msg}</p>
                </div>
              </div>
              <Button variant="outline" className="w-full" onClick={() => router.push("/workspaces")}>
                返回工作区列表
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
