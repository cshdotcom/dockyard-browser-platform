"use client"

// WS 枢纽客户端 hook：io("/?XTransformPort=3003") 经 Caddy 网关转发
// 断线自动重连 + 心跳保活 + 身份注册 + 资源订阅

import { useEffect, useRef, useState, useCallback } from "react"
import { io, type Socket } from "socket.io-client"

export interface HubNotice {
  title: string
  content: string
  level?: string
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
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    })
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

    // 心跳保活
    const hb = setInterval(() => socket.emit("heartbeat"), 25_000)

    return () => {
      clearInterval(hb)
      socket.disconnect()
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
