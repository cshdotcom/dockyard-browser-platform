# 用新 VncPanel（LiveDesk 集成 + 隔离面板）替换 detail-tabs.tsx 中的旧 VncPanel 函数（235-397 行）
import io

PATH = "/home/z/my-project/src/app/(main)/workspaces/[id]/detail-tabs.tsx"

NEW_PANEL = '''// ================= NoVNC 远程桌面面板（LiveDesk 品牌化查看器） =================
function VncPanel({ workspace, canOperate }: { workspace: WorkspaceDetailData; canOperate: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)

  const refreshKey = async () => {
    setBusy(true)
    try {
      const res = await refreshVncKeyAction({ id: workspace.id })
      if (res.code === 0) { toast.success("VNC 临时密钥已刷新"); router.refresh() } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  // 防退出运维：容器内浏览器进程级重启（同一 Profile 秒级拉起）
  const restartBrowser = async () => {
    setBusy(true)
    try {
      const res = await restartBrowserProcessAction({ id: workspace.id })
      if (res.code === 0) {
        toast.success(res.data?.simulated ? "已触发浏览器进程重启（模拟通道）" : "已触发浏览器进程重启，同一 Profile 秒级拉起")
        router.refresh()
      } else toast.error(res.msg)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <LiveDeskViewer
        workspace={{
          id: workspace.id, uuid: workspace.uuid, name: workspace.name, status: workspace.status,
          novncSessionId: workspace.novncSessionId, ownerName: workspace.ownerName,
          mySharePermission: workspace.mySharePermission, isOwner: workspace.isOwner, isAdmin: workspace.isAdmin,
        }}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> 会话管控
          </CardTitle>
          <CardDescription>
            NoVNC 会话经平台统一网关中转（工作区 UUID + HMAC 单次票据双因子校验），原始内网地址不暴露给浏览器。
            {workspace.mySharePermission === "VIEW" && " 您仅有只读权限：仅可查看画面，键鼠输入在服务端被拦截。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshKey} disabled={!canOperate || busy}>
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1", busy && "animate-spin")} /> 刷新临时密钥
            </Button>
            <Button variant="outline" size="sm" onClick={restartBrowser} disabled={!canOperate || busy} title="容器内浏览器进程退出后由 supervisor 以同一 Profile 自动拉起；此按钮用于卡死时手动触发">
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> 重启浏览器进程
            </Button>
            <span className="text-xs text-muted-foreground">
              防退出：浏览器进程退出后 1 秒内自动以同一 Profile 拉起（supervisor 循环 + RestartPolicy=always + 看门狗自动重建）
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">接入客户端</div>
              <div className="mt-1 font-semibold">{workspace.novncConnCount} 个</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">实时帧率</div>
              <div className="mt-1 font-semibold">{Math.round(workspace.novncFps)} fps</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">活跃时长</div>
              <div className="mt-1 font-semibold">{Math.round(workspace.novncActiveMin)} min</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <div className="text-muted-foreground">会话通道</div>
              <div className="mt-1 font-mono text-[11px] font-semibold truncate">{workspace.novncSessionId?.slice(0, 16) || "-"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <IsolationPanel hardening={workspace.hardening} containerRef={workspace.containerRef} />
    </div>
  )
}

// ================= 安全隔离面板（硬隔离 + 防退出可视化） =================
function IsolationPanel({ hardening, containerRef }: { hardening: Record<string, unknown> | null; containerRef: string | null }) {
  const h = hardening || {}
  const items: { ok: boolean; icon: React.ReactNode; title: string; desc: string }[] = [
    {
      ok: h.readOnlyRootfs !== false,
      icon: <LockKeyhole className="h-4 w-4" />,
      title: "根文件系统只读",
      desc: "容器以 ReadOnlyRootfs 运行，系统目录任何位置不可写入",
    },
    {
      ok: h.capDropAll !== false,
      icon: <Ban className="h-4 w-4" />,
      title: "Capabilities 全部丢弃",
      desc: "CapDrop=ALL + no-new-privileges，禁止 setuid 提权",
    },
    {
      ok: h.isolatedProfileVolume !== false,
      icon: <FolderLock className="h-4 w-4" />,
      title: "仅挂载本人 Profile 卷",
      desc: "唯一持久卷为该用户专属目录；其他用户的资料与文件不在容器命名空间内（不可见即不可读）",
    },
    {
      ok: h.noexecDownloads !== false,
      icon: <Ban className="h-4 w-4" />,
      title: "下载目录 noexec",
      desc: "下载的软件落至 noexec tmpfs，运行即报权限错误（Permission denied）",
    },
    {
      ok: h.restartPolicy === "always",
      icon: <InfinityIcon className="h-4 w-4" />,
      title: "防退出：supervisor 循环",
      desc: "浏览器关闭/崩溃后 1 秒内以同一 Profile 自动拉起；容器级 RestartPolicy=always",
    },
    {
      ok: h.oomHardKill !== false,
      icon: <Gauge className="h-4 w-4" />,
      title: "资源硬限制",
      desc: `CPU ${String(h.cpuLimit ?? "-")} 核 / 内存 ${String(h.memLimitMb ?? "-")}MB / Pids ${String(h.pidsLimit ?? "-")}，超限 OOM 硬终止`,
    },
  ]
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> 安全隔离 · 防退出
          {h.provisioned === "simulated" && <Badge variant="secondary">沙箱演示规格</Badge>}
          {containerRef && (
            <Badge className="bg-teal-600 hover:bg-teal-600">
              <Anchor className="h-3 w-3 mr-1" /> 容器 {containerRef.slice(0, 20)}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          每个会话运行在独立硬隔离容器中：用户无法以任何形式退出浏览器（闪退后立即恢复同一配置环境）；
          对其他用户资料与任何其他文件无读取权限；下载软件运行直接报权限错误。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <div key={it.title} className={cn("flex gap-2 rounded-lg border p-2.5", it.ok ? "border-emerald-500/25 bg-emerald-500/[0.06]" : "border-slate-200 bg-muted/30")}>
              <div className={cn("mt-0.5 shrink-0 rounded-md p-1.5", it.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>
                {it.icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-xs font-semibold">
                  {it.title}
                  {it.ok && <ShieldCheck className="h-3 w-3 text-emerald-600" />}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{it.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
'''

with io.open(PATH, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 旧 VncPanel：第 235 行（注释）到第 397 行（函数结束的 "}"），0 基索引 234..396
start = 234  # line 235
end = 397    # line 398 (CDP comment) 之前
old_block = "".join(lines[start:end])
assert "function VncPanel" in old_block and "sendClipboard" in old_block, "边界校验失败"
assert "// ================= CDP 控制面板 =================" in lines[end], "结束边界校验失败"

lines[start:end] = [NEW_PANEL]
with io.open(PATH, "w", encoding="utf-8") as f:
    f.writelines(lines)
print("VncPanel 已替换为 LiveDesk 集成版，总行数:", len(lines))
