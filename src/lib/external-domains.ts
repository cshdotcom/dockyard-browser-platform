// ============================================================
// r40：外部访问地址体检（External Access Domains Audit）
//
// 收集所有"对外服务/对客户端下发地址"的配置点并给出健康度：
//   ① 平台公网基地址（PUBLIC_BASE_URL env 链）
//   ② 节点公网地址（NODE_PUBLIC_URL / WORKER_PUBLIC_URL）
//   ③ CDP 公网网关（cdp.publicGatewayHost/Port/Tls —— 用户侧外网直连）
//   ④ Worker 主控地址推荐值（worknode.masterApiUrl —— 跨主机部署必填）
//   ⑤ VNC 桥公开模式（VNC_BRIDGE_PUBLIC=gateway/port/url + VNC_BRIDGE_URL）
//   ⑥ CORS 跨域白名单（CORS_ALLOWED_ORIGINS）
//   ⑦ 备份推送节点（backup.pushNodes —— 在线状态核对）
// 语义：ok=已配置且公网可达形态 / warn=私网或 localhost（内网可用，公网不可达）/
//      missing=未配置（附建议与推导链说明）
// 用途：管理员部署验收（"确保该配置的外部公网域名都有配置"）
// ============================================================

import { ENV, isPrivateAddress, corsAllowedOrigins } from "@/lib/env"
import { db } from "@/lib/db"
import { getConfig } from "@/lib/config"

export interface DomainStatusItem {
  key: string
  label: string
  value: string
  source: string
  status: "ok" | "warn" | "missing"
  advice: string
}

function classifyUrl(raw: string, missingAdvice: string, privateAdvice: string): { status: "ok" | "warn" | "missing"; value: string; advice: string } {
  const v = (raw || "").trim()
  if (!v) return { status: "missing", value: "未配置", advice: missingAdvice }
  if (isPrivateAddress(v) || /^localhost/.test(v)) {
    return { status: "warn", value: v, advice: privateAdvice }
  }
  return { status: "ok", value: v, advice: "已配置为公网可达形态 ✓" }
}

export async function collectExternalDomainStatus(): Promise<DomainStatusItem[]> {
  const items: DomainStatusItem[] = []

  // ① 平台公网基地址
  const base = classifyUrl(
    ENV.publicBaseUrl,
    "未设置 PUBLIC_BASE_URL —— 当前按请求 Host 推导（反代必须正确传递 Host 头；建议显式设置，如 https://app.example.com）",
    "PUBLIC_BASE_URL 指向私网/localhost —— 仅内网可用；公网部署请改为公网域名（经反向代理/内网穿透指向本服务）",
  )
  items.push({ key: "publicBaseUrl", label: "平台公网基地址（登录回调/分享链接/桥地址拼接）", value: base.value, source: "env: PUBLIC_BASE_URL > APP_PUBLIC_URL > AUTH_* > NEXTAUTH_URL", status: base.status, advice: base.advice })

  // ② 节点公网地址
  const nodeUrl = ENV.nodePublicUrl || ENV.publicBaseUrl
  const n = classifyUrl(
    nodeUrl,
    "未设置 NODE_PUBLIC_URL —— 节点地址展示回退平台基地址；跨主机部署 Worker 请显式设置",
    "节点公网地址为私网形态 —— Worker/浏览器节点跨主机注册将不可达；仅同机/同网部署可接受",
  )
  items.push({ key: "nodePublicUrl", label: "节点公网地址（Worker/浏览器节点推荐地址）", value: n.value, source: "env: NODE_PUBLIC_URL > WORKER_PUBLIC_URL > 平台基地址", status: n.status, advice: n.advice })

  // ③ CDP 公网网关
  const gwHost = (await getConfig<string>("cdp.publicGatewayHost", "")).trim()
  const gwPort = await getConfig<number>("cdp.gatewayPort", 3006)
  const gwTls = await getConfig<boolean>("cdp.gatewayTls", false)
  const g = classifyUrl(
    gwHost,
    "未配置公网 CDP 网关 —— 用户侧无外网 CDP 直连地址（内网使用无碍；外网直连需求请穿透映射 cdp-gateway 端口后填写）",
    "CDP 公网网关为私网地址 —— 外网工具无法直连；仅内网 CDP 访问可用",
  )
  items.push({
    key: "cdpPublicGateway",
    label: "CDP 公网网关（用户侧外网直连地址）",
    value: gwHost ? `${gwTls ? "wss://" : "ws://"}${gwHost}:${gwPort}` : g.value,
    source: "config: cdp.publicGatewayHost / cdp.gatewayPort / cdp.gatewayTls",
    status: g.status,
    advice: g.status === "ok" ? `网关形态 ${gwTls ? "TLS(wss)" : "明文(ws)"}${gwTls ? "" : " —— 生产建议 TLS"} · 票据窗口 ${await getConfig<number>("cdp.ticketWindowSec", 300)}s` : g.advice,
  })

  // ④ Worker 主控地址推荐
  const masterUrl = (await getConfig<string>("worknode.masterApiUrl", "")).trim()
  const effectiveMaster = masterUrl || ENV.nodePublicUrl || ENV.publicBaseUrl
  const m = classifyUrl(
    masterUrl || ENV.nodePublicUrl,
    "未显式配置 —— 注册凭证按 NODE_PUBLIC_URL/PUBLIC_BASE_URL → 请求地址推导（反代环境建议显式填写）",
    "Worker 主控地址为私网/localhost —— 跨主机 Worker 无法回连主控；仅同机部署可接受（localhost 凭证还会在注册界面红色警示）",
  )
  items.push({
    key: "worknodeMasterApiUrl",
    label: "Worker 主控地址（注册凭证 MASTER_API_URL）",
    value: masterUrl || (effectiveMaster ? `${effectiveMaster}（推导）` : m.value),
    source: "config: worknode.masterApiUrl > env: NODE_PUBLIC_URL",
    status: m.status,
    advice: m.advice,
  })

  // ⑤ VNC 桥公开模式
  const bridgeMode = ENV.vncBridgePublic
  const bridgeUrl = ENV.vncBridgeUrl
  const bridgeDesc = bridgeMode === "gateway"
    ? `统一域名反代（?XTransformPort=${ENV.vncBridgePort}）——跟随平台公网基地址`
    : bridgeMode === "port"
      ? `独立端口直连（主机 IP:${ENV.vncBridgePort}）`
      : `自定义基地址 ${bridgeUrl || "（未填 VNC_BRIDGE_URL！）"}`
  items.push({
    key: "vncBridgePublic",
    label: "VNC 网关桥公开模式",
    value: bridgeDesc,
    source: "env: VNC_BRIDGE_PUBLIC > VNC_BRIDGE_URL",
    status: bridgeMode === "url" && !bridgeUrl ? "missing" : bridgeMode === "gateway" ? base.status : "warn",
    advice: bridgeMode === "url" && !bridgeUrl ? "VNC_BRIDGE_PUBLIC=url 但未填 VNC_BRIDGE_URL —— VNC 桥地址无法生成" : "gateway 模式最简（跟随平台域名）；port 模式需主机端口公网可达",
  })

  // ⑥ CORS 白名单
  items.push({
    key: "corsAllowedOrigins",
    label: "CORS 跨域白名单",
    value: corsAllowedOrigins.length > 0 ? corsAllowedOrigins.join(", ") : "空（仅同源访问）",
    source: "env: CORS_ALLOWED_ORIGINS",
    status: "ok",
    advice: "空=默认同源（最安全）；需要外部页面内嵌查看器时才添加来源",
  })

  // ⑦ 备份推送节点
  const pushNodes = (await getConfig<string>("backup.pushNodes", "")).trim()
  if (pushNodes) {
    const uuids = pushNodes.split(",").map((s) => s.trim()).filter(Boolean)
    const nodes = uuids.length > 0
      ? await db.workNode.findMany({ where: { nodeUuid: { in: uuids } }, select: { nodeUuid: true, status: true, enabled: true } })
      : []
    const byUuid = new Map(nodes.map((n) => [n.nodeUuid, n]))
    const missingNodes = uuids.filter((u) => !byUuid.has(u))
    const offlineNodes = uuids.filter((u) => byUuid.get(u) && (byUuid.get(u)!.status !== "ONLINE" || !byUuid.get(u)!.enabled))
    items.push({
      key: "backupPushNodes",
      label: "备份多节点推送",
      value: `${uuids.length} 个节点${offlineNodes.length > 0 ? `（${offlineNodes.length} 个离线/禁用）` : ""}${missingNodes.length > 0 ? `（${missingNodes.length} 个不存在）` : ""}`,
      source: "config: backup.pushNodes",
      status: missingNodes.length > 0 || offlineNodes.length === uuids.length ? "warn" : "ok",
      advice: missingNodes.length > 0 ? `以下节点 UUID 不存在：${missingNodes.join(", ")}` : "副本推送目标健康",
    })
  }

  return items
}
