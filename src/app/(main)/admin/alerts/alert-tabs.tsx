"use client"

// 告警中心页签切换（query param 驱动 RSC 重新查询）

import * as React from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const TAB_VALUES = ["list", "rules", "webhooks", "notices"] as const

export function AlertTabs({ tab, children }: { tab: string; children: React.ReactNode }) {
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
        <TabsTrigger value="list">告警列表</TabsTrigger>
        <TabsTrigger value="rules">告警规则</TabsTrigger>
        <TabsTrigger value="webhooks">Webhook 规则</TabsTrigger>
        <TabsTrigger value="notices">站内通知</TabsTrigger>
      </TabsList>
      {TAB_VALUES.map((t) => (
        <TabsContent key={t} value={t} className="mt-4">
          {tab === t ? children : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}
