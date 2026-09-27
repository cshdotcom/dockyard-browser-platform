import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { authenticateApiToken, TOKEN_PERM } from "@/lib/api-token-auth"
import { writeAudit } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { getConfigBool } from "@/lib/config"
import { runBatchOperation, MCP_OPERATIONS, listTasks, getTaskDetail, controlTask } from "@/server/mcp/engine"

// ============================================================
// MCP 协议统一网关：标准 MCP 请求解析 + 参数校验 + 批量任务体系
// 所有 MCP / OpenAPI 调用统一 APIKey 鉴权、独立限流、独立风控、独立审计
// 批量任务：独立任务UUID、实时进度、失败隔离、重试、状态查询
// ============================================================

// 标准MCP工具调用：POST { code, params, targets } 或 JSON-RPC 风格 { jsonrpc, method: "tools/call", params: { code, ... } }
const callSchema = z.object({
  code: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  targets: z.array(z.string()).optional().default([]),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional().default("MEDIUM"),
})

// JSON-RPC 2.0 封装（兼容标准 MCP 客户端）
const jsonRpcSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.object({
    code: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    targets: z.array(z.string()).optional(),
    priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  }).optional(),
})

function jsonRpcOk(id: unknown, data: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result: { code: 0, data } })
}

export async function POST(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const auth = await authenticateApiToken(req, TOKEN_PERM.EXECUTE)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const ctx = auth.ctx!

  // MCP网关全局开关
  const mcpEnabled = await getConfigBool("mcp.enabled", true)
  if (!mcpEnabled) return NextResponse.json({ code: 40300, msg: "MCP/OpenAPI 网关已被管理员关闭", traceId }, { status: 403 })

  // 幂等防护（外部调用防重放）
  const idempotencyKey = req.headers.get("x-idempotency-key") || ""
  if (idempotencyKey && rateLimit(`mcp-idem:${ctx.tokenId}:${idempotencyKey}`, 1, 30_000).allowed === false) {
    return NextResponse.json({ code: 42901, msg: "重复的幂等键请求已拦截", traceId }, { status: 429 })
  }

  const raw = await req.json().catch(() => ({}))

  // ---- JSON-RPC 风格解析 ----
  if (raw && typeof raw === "object" && "jsonrpc" in raw) {
    const parsed = jsonRpcSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })
    }
    const p = parsed.data
    if (p.method === "tools/list") {
      return jsonRpcOk(p.id, { tools: MCP_OPERATIONS.map((op) => ({ name: op.code, description: op.description, inputSchema: op.schema })) })
    }
    if (p.method === "tasks/list") {
      const tasks = await listTasks(ctx.userId, 20)
      return jsonRpcOk(p.id, tasks)
    }
    const code = p.params?.code
    if (!code) return NextResponse.json({ jsonrpc: "2.0", id: p.id ?? null, error: { code: -32602, message: "缺少操作 code" } })
    const result = await runBatchOperation({
      code,
      params: p.params?.arguments || {},
      targets: p.params?.targets || [],
      priority: p.params?.priority || "MEDIUM",
      ctx,
    })
    return jsonRpcOk(p.id, result)
  }

  // ---- 原生风格调用 ----
  const parsed = callSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ code: 40001, msg: parsed.error.issues[0]?.message || "参数错误", traceId }, { status: 200 })
  }
  const p = parsed.data

  // 任务控制操作
  if (p.code === "task.status") {
    const detail = await getTaskDetail(String((p.params as { taskUuid?: string }).taskUuid || ""))
    return NextResponse.json({ code: 0, msg: "ok", data: detail, traceId })
  }
  if (p.code === "task.control") {
    const { taskUuid, action } = p.params as { taskUuid?: string; action?: string }
    const res = await controlTask(ctx, taskUuid || "", (action || "") as "pause" | "resume" | "cancel" | "retry")
    return NextResponse.json({ code: res.ok ? 0 : 40001, msg: res.message, traceId })
  }

  const result = await runBatchOperation({ code: p.code, params: p.params, targets: p.targets, priority: p.priority, ctx })
  await writeAudit({
    operatorUserId: ctx.userId,
    operatorName: ctx.username,
    operationType: "MCP_CALL",
    resourceType: "MCP",
    resourceId: result.taskUuid,
    after: { code: p.code, targets: p.targets.length, priority: p.priority, success: result.successItems, failed: result.failedItems },
  })
  return NextResponse.json({ code: 0, msg: "ok", data: result, traceId })
}

// GET：任务列表 / 操作目录
export async function GET(req: NextRequest) {
  const traceId = crypto.randomUUID()
  const auth = await authenticateApiToken(req, TOKEN_PERM.READ)
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status })
  const ctx = auth.ctx!

  const view = req.nextUrl.searchParams.get("view") || "ops"
  if (view === "tasks") {
    const tasks = await listTasks(ctx.userId, 50)
    return NextResponse.json({ code: 0, msg: "ok", data: tasks, traceId })
  }
  if (view === "task") {
    const uuid = req.nextUrl.searchParams.get("uuid") || ""
    const detail = await getTaskDetail(uuid)
    return NextResponse.json({ code: 0, msg: "ok", data: detail, traceId })
  }
  // 操作目录
  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: {
      protocol: "MCP-compatible",
      operations: MCP_OPERATIONS.map((op) => ({ code: op.code, description: op.description, batch: op.batch, danger: op.danger })),
      usage: {
        endpoint: "/api/mcp",
        method: "POST",
        headers: { "x-api-key": "<token>", "Content-Type": "application/json" },
        body: { code: "<operation>", params: {}, targets: ["<resourceId>"], priority: "HIGH|MEDIUM|LOW" },
        jsonrpc: { method: "tools/call", params: { code: "<operation>", arguments: {} } },
      },
    },
    traceId,
  })
}
