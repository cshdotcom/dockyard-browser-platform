import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAuthContext } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { randomBytes, createHash } from "crypto"
import { z } from "zod"
import { ENV } from "@/lib/env"
import { getConfig } from "@/lib/config"

// ============================================================
// r29：Worker 节点注册（Master 侧）
// POST /api/master/worknode/create —— 仅超级管理员
//   生成 WORKER_NODE_UUID + WORKER_API_KEY（明文仅本次响应返回一次，库中只存 SHA-256）
// r36：MASTER_API_URL 可配置（修复注册凭证显示 localhost 根因）：
//   优先级：请求体 masterApiUrl（注册对话框可编辑）> 后台配置 worknode.masterApiUrl
//   > 环境变量 NODE_PUBLIC_URL / WORKER_PUBLIC_URL / PUBLIC_BASE_URL > 请求 origin。
//   注：req.nextUrl.origin 在反代/本地访问场景会推导出 localhost / 内网地址 ——
//   跨主机部署的 Worker 无法用其回连主控 → 必须允许管理员显式指定公网地址。
// ============================================================

const schema = z.object({
  name: z.string().min(2).max(60),
  region: z.string().min(1).max(60).default("default"),
  note: z.string().max(200).optional(),
  maxSandboxes: z.number().int().min(1).max(200).default(20),
  masterApiUrl: z.string().max(300).optional(), // r36：显式覆盖（https://master.example.com）
})

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

// MASTER_API_URL 解析（优先级链见文件头注释）
async function resolveMasterApiUrl(req: NextRequest, explicit?: string): Promise<string> {
  const clean = (v: string) => v.trim().replace(/\/+$/, "")
  if (explicit && /^https?:\/\//i.test(clean(explicit))) return clean(explicit)
  const fromConfig = clean(await getConfig("worknode.masterApiUrl", ""))
  if (fromConfig && /^https?:\/\//i.test(fromConfig)) return fromConfig
  // 环境推荐链（r28 已有语义：NODE_PUBLIC_URL 专用于节点 > WORKER_PUBLIC_URL > 公网基址）
  const fromEnv = clean(ENV.nodePublicUrl || ENV.publicBaseUrl)
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv
  // 最后回退：请求 origin（同机部署可用；跨主机需管理员配置上面两级之一）
  try { return new URL(req.nextUrl.origin).origin } catch { return "" }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getAuthContext().catch(() => null)
    if (!ctx) return NextResponse.json({ code: 40100, msg: "未登录" }, { status: 401 })
    if (ctx.role !== "SUPER_ADMIN") {
      return NextResponse.json({ code: 40300, msg: "仅超级管理员可创建 Worker 节点" }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const p = schema.safeParse(body)
    if (!p.success) {
      return NextResponse.json({ code: 40001, msg: `参数错误：${p.error.issues[0]?.message || "格式非法"}` }, { status: 400 })
    }

    const dup = await db.workNode.findFirst({ where: { name: p.data.name } })
    if (dup) return NextResponse.json({ code: 40900, msg: "已存在同名节点" }, { status: 409 })

    const nodeUuid = `wn-${randomBytes(8).toString("hex")}`
    const apiKey = `wak-${randomBytes(24).toString("hex")}`

    const node = await db.workNode.create({
      data: {
        nodeUuid,
        name: p.data.name,
        region: p.data.region,
        note: p.data.note,
        apiKeyHash: hashKey(apiKey),
        maxSandboxes: p.data.maxSandboxes,
        status: "PENDING",
        createdByUserId: ctx.userId,
      },
    })

    await writeAudit({
      operatorUserId: ctx.userId, operatorName: ctx.username,
      operationType: "WORKNODE_CREATE", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
      after: { nodeUuid, region: node.region, maxSandboxes: node.maxSandboxes, masterApiUrlSource: p.data.masterApiUrl ? "explicit" : "auto" },
      severity: "WARN",
    }).catch(() => null)

    const masterApiUrl = await resolveMasterApiUrl(req, p.data.masterApiUrl)
    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        nodeId: node.id,
        nodeUuid,
        apiKey,
        deploy: {
          MASTER_API_URL: masterApiUrl,
          WORKER_NODE_UUID: nodeUuid,
          WORKER_API_KEY: apiKey,
        },
        masterApiUrlHint:
          /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(masterApiUrl)
            ? "注意：当前 MASTER_API_URL 是本机回环地址 —— 跨主机部署的 Worker 将无法回连主控。请把后台「worknode.masterApiUrl」配置为主控公网地址（如 https://master.example.com），或在上方注册表单手动填写后重新生成。"
            : null,
      },
    })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: `创建失败：${(e as Error).message}` }, { status: 500 })
  }
}
