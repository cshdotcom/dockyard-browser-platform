"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

const chartConfig = {
  sessions: { label: "新增工作区", color: "var(--chart-1)" },
  vnc: { label: "NoVNC会话", color: "var(--chart-2)" },
} satisfies ChartConfig

export function TrendChart({ data }: { data: { day: string; sessions: number; vnc: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">工作区创建趋势（近7天）</CardTitle>
        <CardDescription>含CDP轻量会话与NoVNC重度会话</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">暂无数据</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-56 w-full">
            <AreaChart data={data} margin={{ left: -20, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area dataKey="sessions" type="monotone" fill="var(--color-sessions)" fillOpacity={0.25} stroke="var(--color-sessions)" strokeWidth={2} />
              <Area dataKey="vnc" type="monotone" fill="var(--color-vnc)" fillOpacity={0.2} stroke="var(--color-vnc)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
