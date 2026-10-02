"use client"

// 定时任务页签切换（query param 驱动 RSC 重新查询，非客户端状态）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function TaskTabs({ tab, children }: { tab: "list" | "logs"; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const switchTab = (v: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", v)
    params.delete("page")
    params.delete("focus") // r23-b：切页签撤销任务行 focus 高亮（仅任务列表使用）
    if (v === "logs") {
      // 切到日志页签时清除任务列表专属筛选，避免无效参数残留
      params.delete("taskEnabled")
      params.delete("taskKind")
      params.delete("taskStatus")
    } else {
      params.delete("logFrom")
      params.delete("logTo")
      params.delete("triggerType")
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <Tabs value={tab} onValueChange={switchTab} className="w-full">
      <TabsList>
        <TabsTrigger value="list">任务列表</TabsTrigger>
        <TabsTrigger value="logs">执行日志</TabsTrigger>
      </TabsList>
      <TabsContent value="list" className="mt-4">{tab === "list" ? children : null}</TabsContent>
      <TabsContent value="logs" className="mt-4">{tab === "logs" ? children : null}</TabsContent>
    </Tabs>
  )
}
