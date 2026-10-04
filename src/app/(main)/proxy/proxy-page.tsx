"use client"

import * as React from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/shared/data-table"
import { ExternalLink } from "lucide-react"

interface ProxyRow {
  id: string
  name: string
  wsStatus: string
  mode: string
  proxyName: string | null
  proxyType: string | null
  proxyStatus: string | null
  socksAddr: string | null
}

interface Props {
  stats: Array<{ label: string; value: string; icon: React.ReactNode }>
  rows: ProxyRow[]
}

export function ProxyPage({ stats, rows }: Props) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">代理 / 加速器</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          我的浏览器工作区代理绑定与平台代理通道状态（管理员在「网络管理 / SingBox 实例」维护通道与订阅导入）
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">{s.icon}{s.label}</CardTitle>
              <CardContent className="pt-0"><div className="text-2xl font-bold">{s.value}</div></CardContent>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">我的工作区代理绑定</CardTitle>
          <CardDescription>
            每个工作区的出口代理通道；「直连」表示浏览器流量不经代理。切换通道请在工作区详情「网络与代理」页签操作。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无工作区 —— <Link href="/workspaces" className="text-primary underline inline-flex items-center gap-1">去创建 <ExternalLink className="h-3 w-3" /></Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>工作区</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>代理通道</TableHead>
                    <TableHead>通道状态</TableHead>
                    <TableHead className="hidden md:table-cell">SOCKS 端点</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link href={`/workspaces/${r.id}`} className="font-medium text-primary hover:underline">{r.name}</Link>
                        <span className="ml-1 text-[11px] text-muted-foreground">{r.mode === "novnc_full" ? "VNC" : "CDP"}</span>
                      </TableCell>
                      <TableCell><StatusBadge status={r.wsStatus} /></TableCell>
                      <TableCell>
                        {r.proxyType ? <Badge variant="outline" className="font-mono text-[10px]">{r.proxyType}</Badge> : <span className="text-muted-foreground">直连</span>}
                      </TableCell>
                      <TableCell>{r.proxyName || <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell>{r.proxyStatus ? <StatusBadge status={r.proxyStatus} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">{r.socksAddr || "-"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
