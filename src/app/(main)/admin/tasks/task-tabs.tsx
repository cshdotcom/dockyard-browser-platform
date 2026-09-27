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
