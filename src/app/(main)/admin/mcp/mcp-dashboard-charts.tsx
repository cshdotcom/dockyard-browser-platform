"use client"

// MCP 任务看板图表（recharts + shadcn/chart 封装）：
//   · 状态分布环形图 · 14 天任务量趋势 · 操作类型 Top · 发起用户 Top
// 服务端聚合数据传入（本组件纯渲染）

import * as React from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

export interface McpStatusSlice { status: string; count: number; color: string }
export interface McpTrendPoint { day: string; created: number; finished: number }
export interface McpCodeBar { code: string; count: number; success: number }
export interface McpUserBar { username: string; count: number }

const trendConfig = {
  created: { label: "新建任务", color: "var(--chart-1)" },
  finished: { label: "结束任务", color: "var(--chart-2)" },
} satisfies ChartConfig

const codeConfig = { count: { label: "任务数", color: "var(--chart-3)" } } satisfies ChartConfig
const userConfig = { count: { label: "任务数", color: "var(--chart-4)" } } satisfies ChartConfig

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待执行",
  RUNNING: "执行中",
  PAUSED: "已暂停",
  SUCCESS: "成功",
  PARTIAL: "部分成功",
  FAILED: "失败",
  ROLLED_BACK: "已回滚",
  CANCELLED: "已取消",
}

export function McpDashboardCharts({
  statusData,
  trendData,
  codeData,
  userData,
}: {
  statusData: McpStatusSlice[]
  trendData: McpTrendPoint[]
  codeData: McpCodeBar[]
  userData: McpUserBar[]
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* 状态分布 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">任务状态分布</CardTitle>
          <CardDescription>全量任务按状态聚合</CardDescription>
        </CardHeader>
        <CardContent>
          {statusData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无数据</p>
          ) : (
            <div className="flex items-center gap-4">
              <ChartContainer config={{}} className="h-48 w-48 shrink-0">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="status" />} />
                  <Pie data={statusData} dataKey="count" nameKey="status" innerRadius={45} outerRadius={72} paddingAngle={2} strokeWidth={1}>
                    {statusData.map((s) => (
                      <Cell key={s.status} fill={s.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
              <div className="grid gap-1.5 text-xs min-w-0 flex-1">
                {statusData.map((s) => (
                  <div key={s.status} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                    <span className="text-muted-foreground truncate">{STATUS_LABEL[s.status] || s.status}</span>
                    <span className="ml-auto font-mono font-semibold">{s.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 14 天趋势 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">任务量趋势（近 14 天）</CardTitle>
          <CardDescription>新建与结束任务数</CardDescription>
        </CardHeader>
        <CardContent>
          {trendData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无数据</p>
          ) : (
            <ChartContainer config={trendConfig} className="h-48 w-full">
              <AreaChart data={trendData} margin={{ left: -20, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area dataKey="created" type="monotone" fill="var(--color-created)" fillOpacity={0.25} stroke="var(--color-created)" strokeWidth={2} />
                <Area dataKey="finished" type="monotone" fill="var(--color-finished)" fillOpacity={0.2} stroke="var(--color-finished)" strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* 操作类型 Top */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">操作类型 Top 10</CardTitle>
          <CardDescription>按任务 code 聚合（蓝绿双色为成功数）</CardDescription>
        </CardHeader>
        <CardContent>
          {codeData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无数据</p>
          ) : (
            <ChartContainer config={codeConfig} className="h-56 w-full">
              <BarChart data={codeData} layout="vertical" margin={{ left: 8, right: 16, top: 4 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis type="category" dataKey="code" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} width={120} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* 发起用户 Top */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">发起用户 Top 10</CardTitle>
          <CardDescription>按发起用户聚合（全用户 MCP 调用画像）</CardDescription>
        </CardHeader>
        <CardContent>
          {userData.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无数据</p>
          ) : (
            <ChartContainer config={userConfig} className="h-56 w-full">
              <BarChart data={userData} layout="vertical" margin={{ left: 8, right: 16, top: 4 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis type="category" dataKey="username" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} width={100} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
