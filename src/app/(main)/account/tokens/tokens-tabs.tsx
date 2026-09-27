"use client"

// 令牌页页签切换（query param 驱动 RSC 重新查询）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function TokensTabs({ tab, children }: { tab: "list" | "logs"; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const switchTab = (v: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", v)
    params.delete("page")
    if (v === "list") {
      // 令牌页签使用 enabled 筛选；日志页签使用 tokenId 筛选，切换时清理不相关参数
      params.delete("tokenId")
    } else {
      params.delete("enabled")
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <Tabs value={tab} onValueChange={switchTab} className="w-full">
      <TabsList>
        <TabsTrigger value="list">令牌列表</TabsTrigger>
        <TabsTrigger value="logs">调用日志</TabsTrigger>
      </TabsList>
      <TabsContent value="list" className="mt-4">{tab === "list" ? children : null}</TabsContent>
      <TabsContent value="logs" className="mt-4">{tab === "logs" ? children : null}</TabsContent>
    </Tabs>
  )
}
