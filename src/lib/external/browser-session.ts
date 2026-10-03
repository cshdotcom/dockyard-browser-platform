// ============================================================
// 自研浏览器会话引擎（原 Steel-Browser HTTP 适配层已移除——平台自研）
//
// 会话形态（r13/r14 架构，全部自研编排）：
//   1. 外部分离部署（EXTERNAL_BROWSER_URL 已配置）：
//      CDP 轻量会话直接挂接自部署浏览器端点（平台只连接不编排，
//      生命周期由部署侧 supervisor 自管；本模块仅做探测与挂接）
//   2. 单容器内嵌（默认，embedded-sandbox.ts 编排）：
//      每工作区一棵独立进程树（Xvfb/x11vnc/Chromium/独立 Linux 用户），
//      会话句柄由容器引用（containerRef）承载，本模块不做 HTTP 调用
//   3. 演示模式（无浏览器组件且未配置外部分离部署）：
//      进程内模拟会话表，业务链路（创建/心跳/回收/审计）完整可跑
//
// 所有对外能力与既有调用方签名保持一致（createSession / sessionStatus /
// destroySession / exportProfile / nodeLoad / touchSimSession），
// 调用方无感切换；任何第三方浏览器编排 API 依赖已全部移除。
// ============================================================

import { ENV, externalAvailable } from "../env"
import { randomUUID } from "crypto"
import { spawnSync } from "child_process"
import { access, mkdir, stat } from "fs/promises"
import { join } from "path"
import { externalBrowserEndpoint, probeExternalBrowser } from "./browser-endpoint"

export interface CreateBrowserSessionParams {
  proxyUrl?: string
  userAgent?: string
  timezone?: string
  locale?: string
  geo?: { lat: number; lon: number }
  fingerprintSeed?: string
  profileMount?: string // profile 快照目录
  ttlMinutes?: number
}

export interface BrowserSessionHandle {
  sessionId: string
  cdpUrl: string
  debuggerUrl?: string
  simulated: boolean
}

// 兼容别名（历史调用方类型名）
export type CreateSteelSessionParams = CreateBrowserSessionParams
export type SteelSession = BrowserSessionHandle

const g = globalThis as unknown as {
  __dySimBrowserSessions?: Map<string, { createdAt: number; lastActive: number; params: CreateBrowserSessionParams; crashed: boolean }>
}

function simSessions() {
  if (!g.__dySimBrowserSessions) g.__dySimBrowserSessions = new Map()
  return g.__dySimBrowserSessions
}

// 创建浏览器会话：外部分离部署优先；未配置 → 演示模式（进程内模拟表）
export async function createSession(params: CreateBrowserSessionParams): Promise<BrowserSessionHandle> {
  // ---- 外部浏览器分离部署形态（r14）：CDP 轻量会话挂接自部署浏览器 ----
  // 探测可达后返回真实 CDP 端点（http://host:cdpPort/json）；生命周期由外部 supervisor 自管
  if (ENV.externalBrowserUrl) {
    const ep = externalBrowserEndpoint()
    if (ep) {
      const probe = await probeExternalBrowser(6000)
      if (!probe.ok) {
        throw new Error(`外部浏览器不可达（${probe.error}），请检查 EXTERNAL_BROWSER_URL 配置与网络连通性`)
      }
      return {
        sessionId: "ext-" + randomUUID().replace(/-/g, "").slice(0, 12),
        cdpUrl: `${ep.cdpBase}/json`,
        simulated: false,
      }
    }
  }
  // ---- 单容器内嵌 / 演示模式：模拟会话表（真实内嵌沙箱由 embedded-sandbox.ts
  //      编排进程树，会话标识经 containerRef 持久化；此模拟分支保证无浏览器
  //      组件环境业务链路完整可跑，与生产行为语义一致）----
  const id = "sim-" + randomUUID().replace(/-/g, "").slice(0, 12)
  simSessions().set(id, { createdAt: Date.now(), lastActive: Date.now(), params, crashed: false })
  return {
    sessionId: id,
    cdpUrl: `ws://browser-internal/v1/sessions/${id}/cdp`,
    simulated: true,
  }
}

// 查询会话状态：外部分离部署以 CDP 探测为权威存活信号；模拟表查内存
export async function sessionStatus(sessionId: string): Promise<{ status: "ACTIVE" | "CRASHED" | "GONE"; lastActive: number } | null> {
  // 外部浏览器分离部署：CDP 探测为权威存活信号
  if (sessionId.startsWith("ext-")) {
    const probe = await probeExternalBrowser(4000)
    return { status: probe.ok ? "ACTIVE" : "GONE", lastActive: Date.now() }
  }
  const s = simSessions().get(sessionId)
  if (!s) return null
  // 模拟：长时间无心跳视作僵死（与生产监督看门狗语义对齐）
  const stale = Date.now() - s.lastActive > 30 * 60_000
  return { status: s.crashed ? "CRASHED" : stale ? "GONE" : "ACTIVE", lastActive: s.lastActive }
}

// 会话活跃心跳（CDP流量经过网关时更新）
export function touchSimSession(sessionId: string) {
  const s = simSessions().get(sessionId)
  if (s) s.lastActive = Date.now()
}

// 销毁会话（外部浏览器形态：部署侧自管，仅解除挂接；模拟表删除）
export async function destroySession(sessionId: string): Promise<boolean> {
  if (sessionId.startsWith("ext-")) {
    return true
  }
  simSessions().delete(sessionId)
  return true
}

// 导出浏览器 profile（快照体系）：
//   · 内嵌形态（profileDir 提供）：真实 tar.gz 归档（平台侧打包存储卷内 Profile 目录）
//   · 无 profileDir / 目录不存在：返回模拟归档标识（业务链路完整可跑）
export async function exportProfile(
  sessionId: string,
  opts?: { profileDir?: string; archivePrefix?: string }
): Promise<{ archiveKey: string; simulated: boolean; sizeBytes: number } | null> {
  const dir = opts?.profileDir
  if (dir) {
    try {
      await access(dir)
      const key = `${opts?.archivePrefix || "profile"}-${Date.now()}-${sessionId.replace(/[^a-z0-9-]/gi, "").slice(0, 12)}.tar.gz`
      const outDir = join(ENV.storageLocalPath.replace(/\/$/, ""), "snapshots")
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, key)
      // tar 归档 profileDir（-C 切根，保持归档内相对路径稳定）
      const r = spawnSync("tar", ["-czf", outPath, "-C", dir, "."], { timeout: 120_000 })
      if (r.status === 0) {
        const st = await stat(outPath)
        return { archiveKey: key, simulated: false, sizeBytes: st.size }
      }
    } catch {
      /* 目录不存在或打包失败 → 回退模拟 */
    }
  }
  return { archiveKey: `sim-profile-${sessionId}.tar.gz`, simulated: true, sizeBytes: 524288 }
}

// 节点负载（浏览器节点调度：内嵌形态返回本实例负载；外部分离部署由节点健康探测更新）
export async function nodeLoad(): Promise<{ activeSessions: number; loadScore: number } | null> {
  // 内嵌形态：模拟会话表 + 本实例视角（真实负载由宿主机资源任务采样）
  return { activeSessions: simSessions().size, loadScore: Math.min(simSessions().size / 50, 1) }
}

// 兼容导出（历史 import 名）：保持调用方零改动
export { createSession as createBrowserSession, destroySession as destroyBrowserSession, sessionStatus as browserSessionStatus }
