// ============================================================
// 沙箱策略文件即时重写（Policy Apply）
// 管理员变更任何作用域策略后，对运行中/停止的沙箱即时重刷
// Chromium 托管策略文件（只读 bind-mount 的宿主侧写入）：
//   1) 重解析四层（单沙箱 > 用户 > 组 > 全局）全策略面
//   2) CRX 五级策略合并 → Managed Preferences
//   3) writeNetworkPolicyFile(ws-<profileKey>) —— 同一 bind 源文件
//   4) 调用方随后 restartBrowserProcessInContainer（USR1）让 Chromium 重读
// 停止状态的沙箱下次启动自然读取最新文件；运行中需进程重启。
// ============================================================

import { db } from "./db"
import { writeNetworkPolicyFile, sessionNetworkGateway, embeddedSandboxBaseline } from "./network-policy"
import { rememberPolicyFileHash } from "./crx-lifecycle"
import { resolveAccessPolicies } from "./domain-policy"
import { buildCrxManagedPolicy, resolveWorkspaceCrxPolicy } from "./crx-policy"
import { exitGuardManagedPolicy, validateExtraPolicies } from "./chromium-policies"
import { resolveHardwarePolicy, hardwareManagedPolicies } from "./hardware-perms"
import { getConfig } from "./config"
import { ENV, externalAvailable } from "./env"
import { decrypt } from "./crypto"

// 只读组装代理锁定地址（与启动链路 buildProxyUrl 同语义，去掉会话计数校验 —— 刷新场景不占用新会话）
async function resolveProxyLockUrl(proxyNodeId: string | null | undefined): Promise<string | null> {
  if (!proxyNodeId) return null
  const node = await db.proxyNode.findFirst({ where: { id: proxyNodeId, deletedAt: null }, select: { type: true, protocol: true, host: true, port: true, username: true, password: true, singboxInstanceId: true, status: true } })
  if (!node) return null
  if (node.type === "internal_singbox") {
    const inst = node.singboxInstanceId ? await db.singboxInstance.findFirst({ where: { id: node.singboxInstanceId, deletedAt: null }, select: { socksAddr: true } }) : null
    return inst?.socksAddr ? `socks5://${inst.socksAddr}` : null
  }
  const auth = node.username && node.password ? `${encodeURIComponent(node.username)}:${encodeURIComponent(decrypt(node.password))}@` : ""
  return `${node.protocol === "http" ? "http" : "socks5"}://${auth}${node.host}:${node.port}`
}

// 重写沙箱托管策略文件；返回是否成功（沙箱无 profileKey/容器未建过 → false 由调用方按需处理）
export async function refreshWorkspacePolicyFile(workspaceId: string): Promise<boolean> {
  const ws = await db.browserWorkspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    select: { id: true, userId: true, mode: true, hardeningJson: true, profileSnapshotId: true, status: true, proxyNodeId: true, templateId: true },
  })
  if (!ws || ws.mode !== "novnc_full") return false
  const hardening = (ws.hardeningJson as Record<string, unknown> | null) || {}
  const profileKey = (hardening.profileKey as string) || ws.profileSnapshotId || `p-${ws.id.slice(-16)}`
  if (!ws.userId) return false

  // 四层全策略面重解析（网络/域名/端点/文件 + CRX 五级）
  const bundle = await resolveAccessPolicies(ws.userId, ws.id)
  const crxManaged = ws.id
    ? buildCrxManagedPolicy(await resolveWorkspaceCrxPolicy(ws.id).catch(() => ({ entries: [], blocklist: [], inheritEnabled: true, blocklistExempt: false, conflicts: [] })))
    : null
  const gatewayIp = bundle.network.allowSecureLocationAccess ? null : await sessionNetworkGateway().catch(() => null)
  // 代理锁定地址保留（安全位置封禁时 ProxyMode=fixed_servers 不因刷新丢失）
  const proxyUrl = await resolveProxyLockUrl(ws.proxyNodeId).catch(() => null)

  // 单容器内嵌形态：注入 deny-wins 回环基线（跨沙箱 CDP/RFB 段 + 平台端口）；
  // 与创建链路（novnc.ts embedded 分支）同语义，刷新不丢失
  const isEmbedded = (hardening.runtime as string) === "embedded"
  const baseline = isEmbedded ? embeddedSandboxBaseline(!bundle.network.allowSecureLocationAccess) : null

  // r27：模板级策略项 + 防退出档位（与创建链路同语义：模板覆盖 > 全局默认；刷新不丢失）
  let extraManaged: Record<string, unknown> | null = null
  if (ws.templateId) {
    const tpl = await db.browserTemplate.findFirst({ where: { id: ws.templateId, deletedAt: null }, select: { configJson: true } })
    if (tpl) {
      try {
        const cfg = JSON.parse(tpl.configJson || "{}") as Record<string, unknown>
        const pj = (cfg.policyJson || null) as Record<string, unknown> | null
        if (pj && validateExtraPolicies(pj).ok) extraManaged = { ...pj }
      } catch {
        /* 模板配置损坏 → 仅跳过模板项 */
      }
    }
  }
  const exitGuard = ((hardening.exitGuard as string) || await getConfig<string>("workspace.exitGuardDefault", "fullscreen"))

  // r29-a：17 项硬件权限四级链解析 → Chromium 原生策略键注入（刷新不丢失）
  const hw = await resolveHardwarePolicy(ws.userId, ws.id).catch(() => null)
  const hwManaged = hw ? hardwareManagedPolicies(hw.policy) : null

  const path = await writeNetworkPolicyFile(`ws-${profileKey}`, {
    policy: bundle.network,
    gatewayIp,
    proxyUrl,
    domainPolicy: bundle.domain,
    endpointPolicy: bundle.endpoint,
    filePolicy: bundle.file,
    crxManagedPolicy: crxManaged,
    extraBaselineBlock: baseline,
    hardwareManagedPolicy: hwManaged,
    extraManagedPolicy: { ...(extraManaged || null), ...exitGuardManagedPolicy(exitGuard) },
  }).catch(() => null)
  // r26：防篡改哈希登记（后续 policy_tamper_check 周期对账）
  if (path) await rememberPolicyFileHash(workspaceId, path).catch(() => null)
  return !!path
}

// 是否具备自托管容器编排能力（Docker 可用）
export function selfHostedCapable(): boolean {
  return externalAvailable.docker
}

// 策略文件宿主侧路径（诊断/展示用）
export function workspacePolicyFilePath(profileKey: string): string {
  return `${ENV.storageLocalPath.replace(/\/$/, "")}/netpolicy/ws-${profileKey}.json`
}
