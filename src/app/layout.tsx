import type { Metadata } from "next"
import "./globals.css"
import { Toaster } from "@/components/ui/toaster"
import { Toaster as SonnerToaster } from "@/components/ui/sonner"

export const metadata: Metadata = {
  title: {
    default: "Dockyard 浏览器工作平台",
    template: "%s - Dockyard",
  },
  description: "企业级远程浏览器工作平台：浏览器工作区编排、内置 Sing-Box 代理实例管理、多租户权限与安全审计",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
        <SonnerToaster position="top-center" richColors />
      </body>
    </html>
  )
}
