import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

// Prometheus 指标暴露：会话数量/崩溃统计/代理节点/实例指标（访问密钥校验）
export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") || req.headers.get("x-metrics-key") || ""
  const expected = process.env.METRICS_SECRET || ""
  if (expected && key !== expected) {
    return NextResponse.json({ code: 40300, msg: "指标访问密钥校验失败" }, { status: 403 })
  }

  const [workspaces, novnc, singboxes, proxies, users, alerts, mcpTasks] = await Promise.all([
    db.browserWorkspace.count({ where: { status: "RUNNING", deletedAt: null } }),
    db.browserWorkspace.count({ where: { status: "RUNNING", mode: "novnc_full", deletedAt: null } }),
    db.singboxInstance.findMany({ where: { deletedAt: null } }),
    db.proxyNode.findMany({ where: { deletedAt: null } }),
    db.user.count({ where: { deletedAt: null } }),
    db.alert.count({ where: { handleStatus: "PENDING" } }),
    db.mcpTask.count(),
  ])

  const crashed = await db.browserWorkspace.count({ where: { crashCategory: { not: null }, deletedAt: null } })

  const lines: string[] = []
  const emit = (name: string, help: string, type: string, value: number, labels?: string) => {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
    lines.push(`${name}${labels ? "{" + labels + "}" : ""} ${value}`)
  }

  emit("dockyard_workspaces_running", "运行中的浏览器工作区数量", "gauge", workspaces)
  emit("dockyard_workspaces_novnc_running", "运行中的NoVNC会话数量", "gauge", novnc)
  emit("dockyard_workspaces_crashed_total", "累计崩溃会话统计", "counter", crashed)
  emit("dockyard_users_total", "平台用户总数", "gauge", users)
  emit("dockyard_alerts_pending", "待处理告警数", "gauge", alerts)
  emit("dockyard_mcp_tasks_total", "MCP批量任务总数", "counter", mcpTasks)

  for (const inst of singboxes) {
    const labels = `instance="${inst.name}",status="${inst.status}"`
    lines.push(`dockyard_singbox_sessions{${labels}} ${inst.currentSessions}`)
    lines.push(`dockyard_singbox_cpu_limit{${labels}} ${inst.cpuLimit}`)
    lines.push(`dockyard_singbox_mem_limit_mb{${labels}} ${inst.memLimitMb}`)
    lines.push(`dockyard_singbox_traffic_up_mb{${labels}} ${inst.bytesUpMb}`)
    lines.push(`dockyard_singbox_traffic_down_mb{${labels}} ${inst.bytesDownMb}`)
  }
  lines.push("# HELP dockyard_singbox_sessions SingBox实例承载会话数")
  lines.push("# TYPE dockyard_singbox_sessions gauge")

  for (const p of proxies) {
    lines.push(`dockyard_proxy_status{name="${p.name}",status="${p.status}",type="${p.type}"} 1`)
    lines.push(`dockyard_proxy_latency_ms{name="${p.name}"} ${p.latencyMs}`)
  }
  lines.push("# HELP dockyard_proxy_latency_ms 代理节点延迟")
  lines.push("# TYPE dockyard_proxy_latency_ms gauge")

  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  })
}
