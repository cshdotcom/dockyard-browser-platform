"use client"

// 用户头像组件：优先真实头像（/api/avatar?userId=xxx），未设置时回退首字母色块
// 使用方：个人资料页、管理员用户列表、AppShell 用户菜单等

import * as React from "react"
import { cn } from "@/lib/utils"

// 用户名首字母 → 稳定背景色（8 色环）
const PALETTE = [
  "bg-teal-600", "bg-sky-600", "bg-violet-600", "bg-rose-600",
  "bg-amber-600", "bg-emerald-600", "bg-indigo-600", "bg-fuchsia-600",
]
function colorOf(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function initialOf(name: string): string {
  const trimmed = (name || "?").trim()
  // 优先显示字符（中文取首字；英文取首字母大写）
  return trimmed.slice(0, 1).toUpperCase()
}

export function UserAvatar({
  userId,
  name,
  size = 36,
  className,
  square = false,
}: {
  userId: string | null
  name: string
  size?: number
  className?: string
  square?: boolean
}) {
  const [failed, setFailed] = React.useState(false)
  const showImage = userId && !failed

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden flex items-center justify-center select-none",
        square ? "rounded-md" : "rounded-full",
        showImage ? "bg-muted" : colorOf(name || userId || "?"),
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={`${name} 头像`}
    >
      {showImage ? (
         
        <img
          src={`/api/avatar?userId=${encodeURIComponent(userId!)}`}
          alt={`${name} 头像`}
          width={size}
          height={size}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="font-semibold text-white leading-none"
          style={{ fontSize: Math.max(11, Math.round(size * 0.42)) }}
        >
          {initialOf(name)}
        </span>
      )}
    </div>
  )
}
