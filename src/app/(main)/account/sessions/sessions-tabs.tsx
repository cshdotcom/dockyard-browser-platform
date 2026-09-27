"use client"

// 登录设备页页签切换（query param 驱动）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function SessionsTabs({ tab, children }: { tab: "sessions" | "devices"; children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const switchTab = (v: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", v)
    params.delete("page")
    // 两页签使用不同筛选参数，切换时清理
    if (v === "sessions") {
      params.delete("dstate")
    } else {
      params.delete("state")
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <Tabs value={tab} onValueChange={switchTab} className="w-full">
      <TabsList>
        <TabsTrigger value="sessions">登录会话</TabsTrigger>
        <TabsTrigger value="devices">受信任设备</TabsTrigger>
      </TabsList>
      <TabsContent value="sessions" className="mt-4">{tab === "sessions" ? children : null}</TabsContent>
      <TabsContent value="devices" className="mt-4">{tab === "devices" ? children : null}</TabsContent>
    </Tabs>
  )
}
