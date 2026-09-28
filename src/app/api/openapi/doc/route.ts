import { NextRequest, NextResponse } from "next/server"
import { MCP_OPERATIONS } from "@/server/mcp/engine"
import { BROWSER_ACTIONS } from "@/lib/external/cdp-control"

// OpenAPI 3.0 标准化接口文档自动生成：可直接被第三方平台/AI客户端/运维系统对接
// 同时输出 MCP 工具描述（tools/list 兼容）
export async function GET() {
  const paths: Record<string, unknown> = {
    "/api/mcp": {
      post: {
        summary: "MCP 工具调用网关（批量任务）",
        tags: ["MCP"],
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code"],
                properties: {
                  code: { type: "string", description: "操作编码，见 /api/openapi/doc x-mcp-operations" },
                  params: { type: "object", description: "操作参数" },
                  targets: { type: "array", items: { type: "string" }, description: "批量目标资源ID列表" },
                  priority: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "统一返回结构 { code, msg, data, traceId }；data 含 taskUuid/progress/successItems/failedItems",
          },
        },
      },
      get: {
        summary: "MCP 操作目录 / 任务列表",
        tags: ["MCP"],
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: "view", in: "query", schema: { type: "string", enum: ["ops", "tasks", "task"] } },
          { name: "uuid", in: "query", schema: { type: "string" }, description: "view=task 时必填" },
        ],
      },
    },
    "/api/openapi/resources": {
      get: {
        summary: "资源查询（统一归属字段输出）",
        tags: ["OpenAPI"],
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: "resource",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["workspaces", "singbox", "users", "tokens", "recycle", "alerts"] },
          },
        ],
        responses: {
          "200": {
            description: "资源列表：每条含 ownerUserId/ownerUserName/createdByUserId/createdByUserName/userGroupId/userGroupName",
          },
        },
      },
    },
    "/api/metrics": {
      get: {
        summary: "Prometheus 格式指标暴露（访问密钥校验）",
        tags: ["OpenAPI"],
        security: [{ MetricsKey: [] }],
      },
    },
  }

  // —— 浏览器全量控制端点（Steel-Browser 全功能复制；与 MCP browser.* 同层）——
  for (const def of BROWSER_ACTIONS) {
    paths[`/api/openapi/browser/${def.action}`] = {
      post: {
        summary: `[浏览器控制] ${def.summary}`,
        tags: ["Browser Control"],
        security: [{ ApiKeyAuth: [] }],
        description: `权限位：${def.perm === 8 ? "ADMIN" : def.perm === 4 ? "EXECUTE" : def.perm === 2 ? "WRITE" : "READ"}${def.danger ? "（高危）" : ""}；仅限资源所有者或 ADMIN 权限位工作区`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["workspaceId"],
                properties: {
                  workspaceId: { type: "string", description: "工作区 ID 或 UUID" },
                  params: { type: "object", description: Object.entries(def.params).map(([k, v]) => `${k}: ${v}`).join("; ") || "无参数" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ code, msg, data: { action, workspaceId, mode: SIMULATED|LIVE_CDP, data, durationMs }, traceId }" },
          "404": { description: "未知动作（目录见 GET /api/openapi/browser）" },
          "403": { description: "网关关闭 / 无权控制该工作区" },
          "429": { description: "限流（120次/分钟）" },
        },
      },
    }
  }
  paths["/api/openapi/browser"] = {
    get: {
      summary: "浏览器控制动作目录（公开）",
      tags: ["Browser Control"],
      security: [],
    },
  }

  const spec = {
    openapi: "3.0.3",
    info: {
      title: "Dockyard 浏览器工作平台 OpenAPI",
      version: "1.0.0",
      description:
        "企业级远程浏览器工作平台对外接口。统一网关：单域名+单WebSocket+单API入口；APIKey隔离全部资源（APIKey=租户，UUID=资源，Token=用户，SessionID=客户端，DeviceID=设备 五重隔离）。鉴权：请求头 x-api-key。所有响应 { code, msg, data, traceId }。",
    },
    servers: [{ url: "/", description: "统一网关入口（与Web控制台同域）" }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
        MetricsKey: { type: "apiKey", in: "query", name: "key" },
      },
      schemas: {
        ApiResponse: {
          type: "object",
          properties: {
            code: { type: "integer", description: "0=成功" },
            msg: { type: "string" },
            data: { type: "object", nullable: true },
            traceId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths,
    "x-mcp-operations": MCP_OPERATIONS.map((op) => ({
      code: op.code,
      description: op.description,
      batch: op.batch,
      danger: !!op.danger,
      requiredPermission: op.perm === 8 ? "ADMIN" : op.perm === 4 ? "EXECUTE" : op.perm === 2 ? "WRITE" : "READ",
      inputSchema: op.schema,
    })),
    "x-browser-actions": BROWSER_ACTIONS.map((a) => ({
      action: a.action,
      summary: a.summary,
      params: a.params,
      requiredPermission: a.perm === 8 ? "ADMIN" : a.perm === 4 ? "EXECUTE" : a.perm === 2 ? "WRITE" : "READ",
    })),
    "x-rate-limits": {
      perKeyPerSecond: "mcp.perKeyPerSecond 配置（默认20）",
      perKeyPerMinute: "默认300",
      perKeyPerHour: "默认5000",
    },
  }
  return NextResponse.json(spec)
}
