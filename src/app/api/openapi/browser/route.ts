import { NextResponse } from "next/server"
import { listBrowserActions } from "@/lib/external/cdp-control"

// 浏览器控制动作目录（公开：仅描述，不含敏感信息）
// POST /api/openapi/browser/<action> 为执行入口（鉴权见 [action]/route.ts）
export async function GET() {
  return NextResponse.json({
    code: 0,
    msg: "ok",
    data: {
      protocol: "OpenAPI 3.0 compatible",
      endpoint: "/api/openapi/browser/<action>",
      method: "POST",
      auth: { type: "ApiKeyAuth", header: "x-api-key" },
      note: "body 携带 workspaceId 与动作参数；完整 schema 见 /api/openapi/doc",
      actions: listBrowserActions(),
    },
    traceId: crypto.randomUUID(),
  })
}
