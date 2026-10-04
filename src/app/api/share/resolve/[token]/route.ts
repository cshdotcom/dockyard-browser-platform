import { NextRequest } from "next/server"
import { apiHandler } from "@/lib/api"
import { resolvePublicShare } from "@/lib/file-share"

// r28 公开分享解析：POST /api/share/resolve/<token>  { visitorKey? }
// 返回分享元数据 + 文件清单（预览能力标注）；密钥错误/过期/撤销统一 404/403（防探测）
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return apiHandler(async () => {
    const { token } = await params
    const body = (await req.json().catch(() => ({}))) as { visitorKey?: string }
    const view = await resolvePublicShare(token, body.visitorKey)
    return view
  })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return apiHandler(async () => {
    const { token } = await params
    const visitorKey = req.nextUrl.searchParams.get("key") || undefined
    const view = await resolvePublicShare(token, visitorKey)
    return view
  })
}
