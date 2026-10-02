# Dockyard 开发指南（子代理必读）

## 项目概述
企业级远程浏览器工作平台。Next.js 16 App Router + TypeScript + Prisma(SQLite) + NextAuth v4 + Tailwind 4 + shadcn/ui。
- 语言：**全部中文界面文案**
- 颜色：主色 teal 系（`bg-teal-600`、`text-teal-600`），禁止 indigo/blue 主色调
- 页面路由：`src/app/(main)/...`（已登录区域，layout 已含侧边栏/顶栏）
- Server Actions：`src/server/actions/<模块>.ts`
- 环境固定：dev server 自动运行于 3000 端口，勿运行 dev/build；可用 `bun run lint`

## 绝对禁止
- 修改：`src/lib/**`、`src/components/layout/**`、`src/app/(main)/layout.tsx`、`src/proxy.ts`、`prisma/schema.prisma`、`package.json`（只能 import 使用）
- 修改其他代理负责的目录（见任务分派）
- 输出伪代码；所有功能必须真实实现
- 在任何页面使用 `localStorage` 存敏感令牌

## 可用核心库（已实现，直接 import）

### 权限与会话 `@/lib/permissions`
```ts
requireAuth(): Promise<AuthContext>            // 未登录抛 BizError(40100)
requireAdmin(): Promise<AuthContext>           // SUPER_ADMIN/ADMIN
requireSuperAdmin()
requireRole(["SUPER_ADMIN","ADMIN","GROUP_ADMIN"])
getAuthContext(): Promise<AuthContext | null>  // 可空
// AuthContext: { userId, username, displayName, email, role, loginSessionId }
requireWritableMode()                          // 维护/只读模式拦截（写操作前调用）
isPermissionLocked(userId, "blockCreateWorkspace"): Promise<boolean>
requirePermission(userId, "blockExportData", "提示语")  // 权限锁，抛 BizError
requireResourceAccess(ctx, resource, "EDIT"|"DELETE"|"VIEW"|"EXECUTE"|"SHARE"|"EXPORT", "工作区")
// resource 须含 userId/groupId 字段
checkSessionQuota(userId, "sessions"|"novncSessions"): Promise<{ok, reason?, snapshot}>
```

### 审计与安全事件 `@/lib/audit`
```ts
writeAudit({ operatorUserId, operatorName, operationType: "USER_UPDATE", resourceType: "USER",
  resourceId, resourceName, ownerUserId, createdByUserId, before: {...}, after: {...},
  severity: "INFO"|"WARN"|"CRITICAL", extra: {...} })   // 只插入，禁改删
writeSecurityEvent({ userId, username, eventType: "LOGIN_FAILED", success, detail, ip, userAgent })
```

### 统一返回 `@/lib/api`
```ts
// Server Action 模式（所有 action 文件 "use server"）：
import { actionHandler, type ActionResult } from "@/lib/api"
export async function createUserAction(input: unknown): Promise<ActionResult> {
  return actionHandler(async () => {
    const ctx = await requireAdmin()
    // zod 校验 → 权限校验 → 业务 → 审计 → return data
    return { id: "..." }
  })
}
// ActionResult = { code, msg, data?, traceId? }；BizError 自动转为 {code, msg}
```

### 校验 `@/lib/validators`
```ts
import { z } from "zod"
zodValidate(schema, input)                    // 失败抛 BizError(40001)
zPagination, zId, zEmail, zUsername
zPrecision("CPU限制", 0.001, 64)              // 0.001精度数值，自动clamp+四舍五入
validatePasswordPolicy(password)              // 密码策略（异步）
checkPasswordHistory(userId, newPassword)     // 历史密码（异步）
```

### 回收站（删除必须走这里）`@/lib/recycle`
```ts
moveToRecycle({ resourceType: "WORKSPACE"|"SINGBOX"|"API_TOKEN"|"TEMPLATE"|"SNAPSHOT"|"SCRIPT"|"FILE"|"PROXY_NODE"|"GROUP",
  resourceId, resourceName, ownerUserId, createdByUserId,
  deletedByUserId, deletedByType: "USER"|"ADMIN"|"SYSTEM", reason })
restoreFromRecycle(recycleId, { userId, username, role })
purgeFromRecycle(recycleId, { userId, username })
canUserRestore(userId, { ownerUserId })
```
**规则**：业务删除 = 软删除（设置 prisma `deletedAt: new Date()`）+ moveToRecycle()。所有列表查询 where 必须带 `deletedAt: null`。

### 其它
```ts
// @/lib/db
db.user, db.group, db.groupUser, db.groupAdmin, db.auditLog, db.securityEvent,
db.loginSession, db.refreshToken, db.trustedDevice, db.apiToken, db.apiTokenCallLog,
db.systemConfig, db.configVersion, db.scheduleTask, db.scheduleTaskLog, db.fileMeta, db.backupRecord,
db.alert, db.alertRule, db.notice, db.webhookRule, db.webhookDelivery,
db.browserWorkspace, db.browserTemplate, db.browserProfileSnapshot, db.browserScriptTemplate,
db.browserModifyRule, db.domainRule, db.uaRecord, db.workspaceShare,
db.browserNode, db.proxyNode, db.proxyUsage, db.hostNode,
db.singboxInstance, db.singboxConfigVersion, db.singboxStats,
db.mcpTask, db.mcpTaskItem, db.recycleBin, db.riskListRule, db.userBehaviorProfile,
db.announcement, db.announcementRead, db.userBehaviorProfile, db.idempotencyRecord, ...

// @/lib/config
getConfig<T>("key", fallback), getConfigBool("key", false), getConfigNumber("key", 0)
getAllConfig(), setConfig(key, value, operatorUserId), rollbackConfig(key, version, uid)
// @/lib/alerts
raiseAlert({ title, level: "INFO"|"WARN"|"CRITICAL", content, resourceType, resourceId, ownerUserId, dedupeKey, notifyUserIds })
// @/lib/rate-limit
rateLimit(key, limit, windowMs): { allowed, remaining, resetAt }
// @/lib/idempotency
idempotencyCheck(userId, action, payload, windowMs?) → { repeated, fingerprint, previousResult }
// @/lib/risk
trackBehavior(userId, "CREATE"|"DELETE"|"RESTORE"|"MCP_CALL"|"VNC_MIN"|"BATCH")
// @/lib/crypto
sha256(s), encrypt(s), decrypt(s), generateApiToken(), hashPassword(pw), verifyPassword(pw,hash), maskSensitive(obj)
// @/lib/utils-server
parseListQuery(searchParams) → { page, pageSize, keyword, sortField, sortOrder, filters }
pageSkipTake(q), safeOrderBy(q, ["createdAt","name"], { createdAt: "desc" })
fmtDate(d), fmtBytes(n), toCsv(headers, rows)
```

## 前端组件约定

### 通用表格（必须用）`@/components/shared/data-table`
```tsx
"use client" 页面配套客户端组件或直接在 client 组件里：
<DataTable
  columns={[{ key: "name", title: "名称", sortable: true, render: (row) => <span>{row.name}</span> }]}
  rows={rows} total={total} page={q.page} pageSize={q.pageSize}
  keyword={q.keyword} sortField={q.sortField} sortOrder={q.sortOrder}
  filters={[{ key: "status", placeholder: "状态", options: [{label:"运行中",value:"RUNNING"}] }]}
  rowActions={(row) => <RowActions row={row} />}
  onQueryChange={(patch) => { /* 组装 searchParams 提交路由 */ }}
  selectedIds={sel} onSelectedChange={setSel}
  batchToolbar={<Button onClick={batchOp}>批量操作</Button>}
/>
```
`onQueryChange` 推荐实现：客户端用 `useRouter().push(pathname + "?" + new URLSearchParams({...current, ...patch}))`。

### 确认弹窗 + 0.001精度输入 + 统计卡片 `@/components/shared/confirm`
```tsx
<ConfirmDialog open={open} onOpenChange={setOpen} title="强制物理删除"
  description="不可恢复！" requirePhrase="DELETE" destructive onConfirm={async () => {...}} />
<PrecisionInput value={v} onChange={setV} min={0} max={64} step={0.001} suffix="核" />
<StatCard title="总用户" value={123} sub="含禁用" />
```

### 页面骨架（RSC 服务端数据读取）
```tsx
// src/app/(main)/admin/xxx/page.tsx  —— RSC
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin()
  const sp = await searchParams
  const q = parseListQuery(sp)
  const where = { deletedAt: null, ...buildFilters(q) }
  const [rows, total] = await Promise.all([
    db.xxx.findMany({ where, ...pageSkipTake(q), orderBy: safeOrderBy(q, ["createdAt"], { createdAt: "desc" }) }),
    db.xxx.count({ where }),
  ])
  return ( /* 标题 + 客户端交互组件（传入 rows 须先序列化为普通对象：日期转 string） */ )
}
```
**注意**：RSC → 客户端组件 props 必须可序列化：`Date` 转 `fmtDate()` 字符串或 ISO 字符串；`BigInt` 禁止。

### 客户端交互组件模式
- 表格页交互组件放同目录 `xxx-table.tsx`（"use client"）
- 弹窗表单：Dialog + react-hook-form 或受控 state 均可，zod 前端初校验
- toast：`import { toast } from "sonner"`，成功 `toast.success()`，失败 `toast.error(res.msg)`
- Server Action 调用后 `router.refresh()` 刷新 RSC 数据
- 操作按钮 busy 态：`<Loader2 className="animate-spin" />`
- 高危操作必须 ConfirmDialog（强确认 requirePhrase="DELETE"）

## Prisma 模型字段速查（关键字段）
- User: id username email displayName role(SUPER_ADMIN/ADMIN/GROUP_ADMIN/USER) enabled frozen emailVerified mustChangePassword twoFactorEnabled lockedUntil failedLoginCount preferences(Json) quota(Json:{sessions,novncSessions,diskMb}) lastLoginAt lastLoginIp createdAt deletedAt
- Group: id name description parentId enabled inheritParentQuota quota(Json) reservedQuota(Json) tags(Json) webhookUrl force2fa policy(Json) createdByUserId deletedAt
- LoginSession: id userId ip userAgent deviceLabel deviceId trusted rememberMe expiresAt idleTimeoutSec lastActiveAt revokedAt revokedReason createdAt
- ApiToken: id userId name tokenHash tokenPrefix permissionsMask(Int) ipWhitelist(Json) qpsLimit expireAt(null=永久) enabled lastCallAt callCount failCount deletedAt
- AuditLog: id traceId operatorUserId operatorName operationType resourceType resourceId resourceName ownerUserId createdByUserId clientIp severity beforeJson afterJson extraJson createdAt
- SecurityEvent: id userId username eventType success ip userAgent detail createdAt
- SystemConfig: key valueJson category valueType description version
- ScheduleTask: code name cronExpr enabled timeoutSec dependsOn consecutiveFails lastExecuteAt lastResult; ScheduleTaskLog: taskCode triggerType status startAt endAt durationMs errorStack summary itemsProcessed
- FileMeta: id fileName storageKey size mime checksum category userId workspaceId shareTo(Json) expireAt virusScanned createdByUserId deletedAt
- BackupRecord: id fileMetaId type tableList(Json) encrypted sizeBytes checksum status createdByUserId createdAt
- Alert: id title level(INFO/WARN/CRITICAL) content resourceType resourceId ownerUserId handleStatus(PENDING/HANDLED/AUTO_RESOLVED) handledByUserId handledAt triggerAt dedupeKey createdAt
- Notice: id userId title content type readAt createdAt
- WebhookRule: id name url secret events(Json) groupId enabled failCount
- BrowserWorkspace: id uuid name mode(cdp_light/novnc_full) status(CREATING/RUNNING/IDLE/STOPPED/ERROR/DESTROYED/FROZEN) userId groupId proxyNodeId singboxInstanceId browserNodeId templateId profileSnapshotId tags(Json) browserSessionId cdpUrl novncSessionId novncSecret novncConnCount novncFps novncActiveMin ttlMinutes idleTimeoutMinutes cdpCallCount cdpBlockedCount crashCategory lifecycleRules(Json) expireAt createdByUserId createdAt deletedAt
- BrowserTemplate: id name description scope(PRIVATE/GROUP/GLOBAL) userId groupId parentId configJson version tags createdByUserId deletedAt
- BrowserProfileSnapshot: id name scope userId groupId workspaceId sizeBytes storageKey expireAt createdByUserId deletedAt
- BrowserScriptTemplate: id name description code version scope userId boundDomains(Json) enabled createdByUserId deletedAt
- BrowserModifyRule: id name type(REQ_HEADER/RESP_HEADER/REDIRECT) matchPattern headerKey headerValue redirectUrl enabled templateBinding createdByUserId deletedAt
- DomainRule: id pattern type(BLACK/WHITE) enabled note createdByUserId
- UaRecord: id ua label category(DESKTOP/MOBILE) enabled usageCount
- WorkspaceShare: id workspaceId targetUserId permission(VIEW/OPERATE) expireAt revokedAt createdByUserId
- BrowserNode: id name baseUrl labels(Json) weight status(ONLINE/OFFLINE/ISOLATED) grayGroup(PROD/TEST) activeSessions loadScore probeFailCount enabled deletedAt（自研浏览器节点，Steel 声明已全部移除）
- ProxyNode: id name type(internal_singbox/external) protocol(socks5/http) host port username password status(HEALTHY/DEGRADED/FAILED/DISABLED) latencyMs labels(Json) weight singboxInstanceId maxSessions currentSessions healthFailCount scheduleStrategy createdByUserId deletedAt
- HostNode: id name dockerApiUrl labels(Json) cpuCores memTotalMb cpuUsedPct memUsedMb diskUsedPct reservedCpu reservedMemMb grayGroup status enabled deletedAt
- SingboxInstance: id name remark tags(Json) cpuLimit memLimitMb maxSessions currentSessions hostNodeId containerId status(CREATING/RUNNING/STOPPED/ERROR/RELOADING) socksAddr configJson configVersion autoRestart lastError trafficLimitMb bytesUpMb bytesDownMb overLimitAction ownerUserId createdByUserId expireAt deletedAt
- McpTask: id taskUuid name code priority(HIGH/MEDIUM/LOW) status(PENDING/RUNNING/PAUSED/SUCCESS/FAILED/PARTIAL/ROLLED_BACK/CANCELLED) paramsJson resultJson progress totalItems successItems failedItems failReasonsJson userId createdByUserId startedAt finishedAt
- RecycleBin: id resourceType resourceId resourceName ownerUserId createdByUserId deletedByUserId deletedByType(USER/ADMIN/SYSTEM) reason originalSnapshot locked recoverDeadline purgeAt restoredAt createdAt
- RiskListRule: id type(IP_BLACK/IP_WHITE/UA_BLACK/DEVICE_BLACK) value note mode(TEMP/PERMANENT) expiresAt createdByUserId createdAt
- UserBehaviorProfile: userId resourcesCreated resourcesDeleted resourcesRestored mcpCalls vncDurationMin batchOps abnormalOps riskTriggers
- Announcement: id title content type(GLOBAL/GROUP/USER) groupId userId displayType(POPUP/MARQUEE/FORCE_VIEW) enabled createdByUserId
- GroupUser/GroupAdmin: groupId+userId; GroupAdmin 额外 canModifyQuota
- ProxyUsage: workspaceId proxyNodeId userId groupId bytesUp bytesDown recordedAt sessionDate

## 系统配置键速查
security.allowRegister / security.requireEmailActivation / security.passwordMinLength / security.passwordRequireUpper/Lower/Digit/Special / security.maxLoginFailures / security.lockoutMinutes / security.globalForce2fa / security.allowEmailCodeLogin / security.emailCodeExpireSec / session.maxLifetimeHours / session.idleTimeoutMin / workspace.maxConcurrentSessions / workspace.maxConcurrentNovnc / workspace.reservedSessions / storage.quotaPerUserMb / token.maxPerUser / token.allowPermanent / token.maxLifetimeDays / recycle.retentionMinutes / recycle.userRestoreEnabled / maintenance.enabled / maintenance.message / ui.siteName / mcp.enabled ...

## shadcn 组件可用清单
accordion alert alert-dialog aspect-ratio avatar badge breadcrumb button calendar card carousel chart checkbox collapsible command context-menu dialog drawer dropdown-menu form hover-card input-otp input label menubar navigation-menu pagination popover progress radio-group resizable scroll-area select separator sheet sidebar skeleton slider sonner switch table tabs textarea toast toaster toggle toggle-group tooltip
图标：`lucide-react`（已装）。图表：recharts（已有 chart.tsx 封装 ChartContainer）。
