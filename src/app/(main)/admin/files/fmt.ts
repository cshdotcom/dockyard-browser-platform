// 客户端字节格式化（服务端 fmtBytes 在 lib/server 不可用于 client bundle）

export function fmtBytesClient(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${Math.round(v * 1000) / 1000} ${units[i]}`
}
