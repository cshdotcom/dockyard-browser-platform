"use client"

// WS 枢纽客户端 hook：地址自动推导（按访问域名自动拼接，无需端口参数）——
//   1) 同源 /hub-ws 路径探测（网关把 /hub-ws 路由到 3003 时成立，任意域名可用）
//   2) 失败回退同主机直连 3003（开发机/沙箱直访）
// 断线自动重连 + 心跳保活 + 身份注册 + 资源订阅

import { useEffect, useRef, useState, useCallback } from "react"
import { io, type Socket } from "socket.io-client"

export interface HubNotice {
  title: string
  content: string
  level?: string
}

// ---- 通道自动推导（模块级缓存，全应用共享一次探测） ----
// 1) 网关查询参数模式：/?EIO=4&XTransformPort=3003（统一网关原生支持）
// 2) 同源路径模式：/hub-ws/?EIO=4（网关按路径路由时）
// 3) 直连同主机 3003（开发机/沙箱直访；https 页面会因混合内容失败）
type HubChannel = { mode: "gateway-query" } | { mode: "path" } | { mode: "direct"; port: number }
let hubChannelCache: HubChannel | null = null

async function hubHandshakeOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return false
    return (await r.text()).startsWith("0")
  } catch {
    return false
  }
}

async function resolveHubChannel(): Promise<HubChannel> {
  if (hubChannelCache) return hubChannelCache
  if (await hubHandshakeOk("/?EIO=4&transport=polling&XTransformPort=3003")) {
    hubChannelCache = { mode: "gateway-query" }
  } else if (await hubHandshakeOk("/hub-ws/?EIO=4&transport=polling")) {
    hubChannelCache = { mode: "path" }
  } else if (await hubHandshakeOk(
    `${typeof location !== "undefined" && location.protocol === "https:" ? "https" : "http"}://${location.hostname}:3003/?EIO=4&transport=polling`,
  )) {
    hubChannelCache = { mode: "direct", port: 3003 }
  } else {
    // 兜底：网关查询参数模式（与历史行为一致，由 socket.io 断线重连自行兜底）
    hubChannelCache = { mode: "gateway-query" }
  }
  return hubChannelCache
}

export function useWsHub(opts?: {
  onNotice?: (n: HubNotice) => void
  onForceAction?: (a: { action: string; message: string; type: string; name: string }) => void
  onSessionStatus?: (s: { workspaceId: string; status: string }) => void
}) {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const handlersRef = useRef(opts)

  useEffect(() => {
    handlersRef.current = opts
  }, [opts])

  useEffect(() => {
    let disposed = false
    let socket: Socket | null = null

    resolveHubChannel().then((channel) => {
      if (disposed) return
      if (channel.mode === "path") {
        socket = io({ path: "/hub-ws", transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 2000 })
      } else if (channel.mode === "direct") {
        socket = io(`${typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${channel.port}`, { path: "/", transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 2000 })
      } else {
        // 网关查询参数模式（统一网关原生支持，任意域名可用）
        socket = io("/?XTransformPort=3003", { transports: ["websocket", "polling"], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 2000 })
      }
      socketRef.current = socket

      socket.on("connect", () => setConnected(true))
      socket.on("disconnect", () => setConnected(false))

      socket.on("notice", (n: HubNotice) => {
        handlersRef.current?.onNotice?.(n)
      })
      socket.on("force-action", (a: { action: string; message: string; type: string; name: string }) => {
        handlersRef.current?.onForceAction?.(a)
      })
      socket.on("session-status", (s: { workspaceId: string; status: string }) => {
        handlersRef.current?.onSessionStatus?.(s)
      })
    })

    // 心跳保活（socket 就绪后由 interval 空引用保护）
    const hb = setInterval(() => socketRef.current?.emit("heartbeat"), 25_000)

    return () => {
      disposed = true
      clearInterval(hb)
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [])

  const register = useCallback((data: { userId: string; username?: string; groupIds?: string[]; role?: string }) => {
    socketRef.current?.emit("register", data)
  }, [])

  const subscribe = useCallback((resourceType: string, resourceId: string) => {
    socketRef.current?.emit("subscribe", { resourceType, resourceId })
  }, [])

  return { connected, register, subscribe }
}
