-- ============================================================
-- Dockyard PostgreSQL 全量建表 DDL（自动生成，勿手工编辑）
--
-- 生成方式：bunx prisma migrate diff --from-empty --to-schema-datamodel
--           prisma/schema.postgres.prisma --script
-- 源 schema：prisma/schema.postgres.prisma（由 scripts/db/sync-postgres-schema.ts
--   从 prisma/schema.prisma 派生 —— 模型变更请改主 schema 后重新执行同步与生成）
--
-- 用途：人工初始化场景（推荐使用平台启动自动初始化，见 docker/start.sh /
--   README「PostgreSQL 部署」章节）；与启动自动初始化产物完全等价
-- ============================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "avatarPath" TEXT,
    "avatarUpdatedAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "force2faSetup" BOOLEAN NOT NULL DEFAULT false,
    "lockedUntil" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "preferences" JSONB,
    "quota" JSONB,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "lastLoginCountry" TEXT,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "permissionLocks" JSONB,
    "shareAllowed" BOOLEAN,
    "allowInternalNetwork" BOOLEAN,
    "allowSecureLocationAccess" BOOLEAN,
    "vncSessionMaxMinutes" INTEGER,
    "idleTimeoutMinutes" INTEGER,
    "idleTimeoutLocked" BOOLEAN NOT NULL DEFAULT false,
    "loginSessionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "clientIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenId" TEXT,
    "sessionHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceLabel" TEXT,
    "deviceId" TEXT,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "rememberMe" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "idleTimeoutSec" INTEGER NOT NULL DEFAULT 1800,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT,
    "ua" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpSecret" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TotpSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorBackupCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "eventType" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "ip" TEXT,
    "userAgent" TEXT,
    "detail" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "inheritParentQuota" BOOLEAN NOT NULL DEFAULT true,
    "quota" JSONB,
    "reservedQuota" JSONB,
    "tags" JSONB,
    "webhookUrl" TEXT,
    "force2fa" BOOLEAN NOT NULL DEFAULT false,
    "allowShare" BOOLEAN NOT NULL DEFAULT true,
    "allowInternalNetwork" BOOLEAN NOT NULL DEFAULT false,
    "allowSecureLocationAccess" BOOLEAN NOT NULL DEFAULT false,
    "vncSessionMaxMinutes" INTEGER,
    "idleTimeoutMinutes" INTEGER,
    "idleTimeoutLocked" BOOLEAN NOT NULL DEFAULT false,
    "policy" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupUser" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupAdmin" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canModifyQuota" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupProxy" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "proxyNodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupProxy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "operatorUserId" TEXT,
    "operatorName" TEXT,
    "operationType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "extraJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogArchive" (
    "id" TEXT NOT NULL,
    "originId" TEXT NOT NULL,
    "traceId" TEXT,
    "operatorUserId" TEXT,
    "operatorName" TEXT,
    "operationType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "clientIp" TEXT,
    "severity" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "extraJson" TEXT,
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLogArchive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "permissionsMask" INTEGER NOT NULL DEFAULT 0,
    "scopes" JSONB,
    "ipWhitelist" JSONB,
    "qpsLimit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expireAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCallAt" TIMESTAMP(3),
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiTokenCallLog" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT,
    "tokenUserId" TEXT,
    "path" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "wasExpired" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiTokenCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "valueType" TEXT NOT NULL DEFAULT 'string',
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ConfigVersion" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "operatorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleTask" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpr" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSec" INTEGER NOT NULL DEFAULT 300,
    "dependsOn" TEXT,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "lastExecuteAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "avgDurationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleTask_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ScheduleTaskLog" (
    "id" TEXT NOT NULL,
    "taskCode" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL DEFAULT 'CRON',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorStack" TEXT,
    "summary" TEXT,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScheduleTaskLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resultJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileMeta" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "mime" TEXT,
    "checksum" TEXT,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "userId" TEXT,
    "workspaceId" TEXT,
    "shareTo" JSONB,
    "expireAt" TIMESTAMP(3),
    "virusScanned" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRecord" (
    "id" TEXT NOT NULL,
    "fileMetaId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FULL',
    "tableList" JSONB,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'WARN',
    "content" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "ownerUserId" TEXT,
    "traceId" TEXT,
    "dedupeKey" TEXT,
    "triggerAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handleStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "handledByUserId" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditionsJson" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'WARN',
    "silenceWindowMin" INTEGER NOT NULL DEFAULT 30,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,
    "resourceType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'ALERT',
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "events" JSONB,
    "groupId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "url" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payloadJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserWorkspace" (
    "id" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'cdp_light',
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "userId" TEXT NOT NULL,
    "groupId" TEXT,
    "proxyNodeId" TEXT,
    "singboxInstanceId" TEXT,
    "steelNodeId" TEXT,
    "templateId" TEXT,
    "profileSnapshotId" TEXT,
    "tags" JSONB,
    "steelSessionId" TEXT,
    "cdpUrl" TEXT,
    "novncSessionId" TEXT,
    "novncSecret" TEXT,
    "novncConnCount" INTEGER NOT NULL DEFAULT 0,
    "novncFps" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "novncActiveMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ttlMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "idleTimeoutMinutes" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "vncSessionMaxMinutes" INTEGER,
    "shareDisabled" BOOLEAN NOT NULL DEFAULT false,
    "policyAllowInternalNetwork" BOOLEAN,
    "policyAllowSecureLocationAccess" BOOLEAN,
    "crxInheritEnabled" BOOLEAN NOT NULL DEFAULT true,
    "crxBlocklistExempt" BOOLEAN NOT NULL DEFAULT false,
    "sessionSecAccum" INTEGER NOT NULL DEFAULT 0,
    "cdpCallCount" INTEGER NOT NULL DEFAULT 0,
    "cdpBlockedCount" INTEGER NOT NULL DEFAULT 0,
    "crashCategory" TEXT,
    "lifecycleRules" JSONB,
    "freezeReason" TEXT,
    "expireAt" TIMESTAMP(3),
    "containerRef" TEXT,
    "hardeningJson" JSONB,
    "networkPolicyJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "runtimeAccumSec" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'PRIVATE',
    "userId" TEXT,
    "groupId" TEXT,
    "parentId" TEXT,
    "configJson" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tags" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserProfileSnapshot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'PRIVATE',
    "userId" TEXT,
    "groupId" TEXT,
    "workspaceId" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT,
    "expireAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserScriptTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scope" TEXT NOT NULL DEFAULT 'PRIVATE',
    "userId" TEXT,
    "boundDomains" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserScriptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserScriptRunLog" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "log" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserScriptRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserModifyRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "matchPattern" TEXT NOT NULL,
    "headerKey" TEXT,
    "headerValue" TEXT,
    "redirectUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "templateBinding" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserModifyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainRule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'BLACK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "scopeType" TEXT NOT NULL DEFAULT 'GLOBAL',
    "groupId" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "deploymentId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UaRecord" (
    "id" TEXT NOT NULL,
    "ua" TEXT NOT NULL,
    "label" TEXT,
    "category" TEXT NOT NULL DEFAULT 'DESKTOP',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UaRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceShare" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'VIEW',
    "expireAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceShareLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'VIEW',
    "expireAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "maxUses" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SteelNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "labels" JSONB,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "grayGroup" TEXT NOT NULL DEFAULT 'PROD',
    "activeSessions" INTEGER NOT NULL DEFAULT 0,
    "loadScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "probeFailCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SteelNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'external',
    "protocol" TEXT NOT NULL DEFAULT 'socks5',
    "host" TEXT,
    "port" INTEGER,
    "username" TEXT,
    "password" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "latencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "labels" JSONB,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "singboxInstanceId" TEXT,
    "maxSessions" INTEGER NOT NULL DEFAULT 0,
    "currentSessions" INTEGER NOT NULL DEFAULT 0,
    "healthFailCount" INTEGER NOT NULL DEFAULT 0,
    "scheduleStrategy" TEXT NOT NULL DEFAULT 'LEAST_LOAD',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProxyNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "proxyNodeId" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,
    "bytesUp" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesDown" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionDate" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ProxyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dockerApiUrl" TEXT NOT NULL,
    "labels" JSONB,
    "cpuCores" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memTotalMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cpuUsedPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memUsedMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "diskUsedPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedCpu" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reservedMemMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grayGroup" TEXT NOT NULL DEFAULT 'PROD',
    "status" TEXT NOT NULL DEFAULT 'ONLINE',
    "probeFailCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HostNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SingboxInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "tags" JSONB,
    "cpuLimit" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "memLimitMb" DOUBLE PRECISION NOT NULL DEFAULT 512,
    "maxSessions" INTEGER NOT NULL DEFAULT 0,
    "currentSessions" INTEGER NOT NULL DEFAULT 0,
    "hostNodeId" TEXT,
    "containerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "socksAddr" TEXT,
    "configJson" TEXT,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "autoRestart" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "trafficLimitMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesUpMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesDownMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakTrafficMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overLimitAction" TEXT NOT NULL DEFAULT 'ALERT',
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "expireAt" TIMESTAMP(3),
    "lifecycleRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SingboxInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SingboxConfigVersion" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configJson" TEXT NOT NULL,
    "operatorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SingboxConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SingboxStats" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "cpuPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "memMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesUpMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bytesDownMb" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SingboxStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "harJson" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CdpRecording" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileMetaId" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CdpRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpTask" (
    "id" TEXT NOT NULL,
    "taskUuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paramsJson" TEXT,
    "resultJson" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "successItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "failReasonsJson" TEXT,
    "userId" TEXT,
    "createdByUserId" TEXT,
    "apiTokenId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpTaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "beforeSnapshot" TEXT,
    "afterSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "McpTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecycleBin" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT,
    "ownerUserId" TEXT,
    "createdByUserId" TEXT,
    "deletedByUserId" TEXT,
    "deletedByType" TEXT NOT NULL DEFAULT 'USER',
    "reason" TEXT,
    "originalSnapshot" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "recoverDeadline" TIMESTAMP(3),
    "purgeAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecycleBin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskListRule" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'PERMANENT',
    "expiresAt" TIMESTAMP(3),
    "scopeType" TEXT NOT NULL DEFAULT 'GLOBAL',
    "groupId" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "deploymentId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskListRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDeployment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bundleJson" TEXT NOT NULL,
    "targetUsers" JSONB,
    "targetGroups" JSONB,
    "targetWorkspaces" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "effectiveMode" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "effectiveAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "totalTargets" INTEGER NOT NULL DEFAULT 0,
    "successTargets" INTEGER NOT NULL DEFAULT 0,
    "failedTargets" INTEGER NOT NULL DEFAULT 0,
    "resultsJson" TEXT,
    "snapshotJson" TEXT,
    "note" TEXT,
    "createdByUserId" TEXT,
    "deployedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilePolicyConfig" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "allowDownload" BOOLEAN NOT NULL DEFAULT true,
    "allowUpload" BOOLEAN NOT NULL DEFAULT true,
    "allowFileScheme" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilePolicyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkEndpointRule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'BLACK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "scopeType" TEXT NOT NULL DEFAULT 'GLOBAL',
    "groupId" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "deploymentId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkEndpointRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bundleJson" TEXT NOT NULL,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PolicyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBehaviorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resourcesCreated" INTEGER NOT NULL DEFAULT 0,
    "resourcesDeleted" INTEGER NOT NULL DEFAULT 0,
    "resourcesRestored" INTEGER NOT NULL DEFAULT 0,
    "mcpCalls" INTEGER NOT NULL DEFAULT 0,
    "vncDurationMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "batchOps" INTEGER NOT NULL DEFAULT 0,
    "abnormalOps" INTEGER NOT NULL DEFAULT 0,
    "riskTriggers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBehaviorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GLOBAL',
    "groupId" TEXT,
    "userId" TEXT,
    "displayType" TEXT NOT NULL DEFAULT 'POPUP',
    "displayTypes" TEXT,
    "notifyInbox" BOOLEAN NOT NULL DEFAULT false,
    "notifiedAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "persistAfterRead" BOOLEAN NOT NULL DEFAULT false,
    "allowDismiss" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementDismiss" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissDate" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDismiss_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRead" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceLifecycleRule" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "scopeType" TEXT NOT NULL DEFAULT 'RESOURCE',
    "scopeId" TEXT,
    "rulesJson" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceLifecycleRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSelfCheck" (
    "id" TEXT NOT NULL,
    "checkCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PASS',
    "detail" TEXT,
    "fixedAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSelfCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrxPlugin" (
    "id" TEXT NOT NULL,
    "crxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "zhNote" TEXT,
    "tags" JSONB,
    "permissions" JSONB,
    "updateUrl" TEXT NOT NULL,
    "backupUpdateUrl" TEXT,
    "lockedVersion" TEXT,
    "allowIncognito" BOOLEAN NOT NULL DEFAULT false,
    "allowUserDisable" BOOLEAN NOT NULL DEFAULT true,
    "highRisk" BOOLEAN NOT NULL DEFAULT false,
    "highRiskReason" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "docUrl" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "updatedByUserId" TEXT,
    "updatedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "deletedByName" TEXT,

    CONSTRAINT "CrxPlugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrxPolicyEntry" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "crxId" TEXT NOT NULL,
    "updateUrl" TEXT,
    "backupUpdateUrl" TEXT,
    "lockedVersion" TEXT,
    "allowIncognito" BOOLEAN,
    "allowUserDisable" BOOLEAN,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CrxPolicyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrxBlocklistEntry" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "crxId" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrxBlocklistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrxInstallStatus" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "crxId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceUsed" TEXT,
    "currentVersion" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrxInstallStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrxGrayTask" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entriesJson" TEXT NOT NULL,
    "targetIds" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "batchSize" INTEGER NOT NULL DEFAULT 3,
    "total" INTEGER NOT NULL DEFAULT 0,
    "progressed" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "rollbackReason" TEXT,
    "createdByUserId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CrxGrayTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_enabled_idx" ON "User"("enabled");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "PasswordHistory_userId_createdAt_idx" ON "PasswordHistory"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoginSession_sessionHash_key" ON "LoginSession"("sessionHash");

-- CreateIndex
CREATE INDEX "LoginSession_userId_revokedAt_idx" ON "LoginSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "LoginSession_expiresAt_idx" ON "LoginSession"("expiresAt");

-- CreateIndex
CREATE INDEX "LoginSession_lastActiveAt_idx" ON "LoginSession"("lastActiveAt");

-- CreateIndex
CREATE INDEX "TrustedDevice_userId_idx" ON "TrustedDevice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedDevice_userId_deviceId_key" ON "TrustedDevice"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "EmailVerificationCode_email_purpose_idx" ON "EmailVerificationCode"("email", "purpose");

-- CreateIndex
CREATE INDEX "EmailVerificationCode_expiresAt_idx" ON "EmailVerificationCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TotpSecret_userId_key" ON "TotpSecret"("userId");

-- CreateIndex
CREATE INDEX "TwoFactorBackupCode_userId_idx" ON "TwoFactorBackupCode"("userId");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_eventType_createdAt_idx" ON "SecurityEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE INDEX "Group_parentId_idx" ON "Group"("parentId");

-- CreateIndex
CREATE INDEX "Group_deletedAt_idx" ON "Group"("deletedAt");

-- CreateIndex
CREATE INDEX "GroupUser_userId_idx" ON "GroupUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupUser_groupId_userId_key" ON "GroupUser"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupAdmin_groupId_userId_key" ON "GroupAdmin"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupProxy_groupId_proxyNodeId_key" ON "GroupProxy"("groupId", "proxyNodeId");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_operatorUserId_createdAt_idx" ON "AuditLog"("operatorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_operationType_idx" ON "AuditLog"("operationType");

-- CreateIndex
CREATE INDEX "AuditLogArchive_resourceType_resourceId_idx" ON "AuditLogArchive"("resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_deletedAt_idx" ON "ApiToken"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "ApiToken_expireAt_idx" ON "ApiToken"("expireAt");

-- CreateIndex
CREATE INDEX "ApiTokenCallLog_tokenId_createdAt_idx" ON "ApiTokenCallLog"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiTokenCallLog_tokenUserId_createdAt_idx" ON "ApiTokenCallLog"("tokenUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiTokenCallLog_createdAt_idx" ON "ApiTokenCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemConfig_category_idx" ON "SystemConfig"("category");

-- CreateIndex
CREATE INDEX "ConfigVersion_configKey_version_idx" ON "ConfigVersion"("configKey", "version");

-- CreateIndex
CREATE INDEX "ScheduleTaskLog_taskCode_startAt_idx" ON "ScheduleTaskLog"("taskCode", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_fingerprint_key" ON "IdempotencyRecord"("fingerprint");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileMeta_storageKey_key" ON "FileMeta"("storageKey");

-- CreateIndex
CREATE INDEX "FileMeta_userId_deletedAt_idx" ON "FileMeta"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "FileMeta_category_idx" ON "FileMeta"("category");

-- CreateIndex
CREATE INDEX "FileMeta_expireAt_idx" ON "FileMeta"("expireAt");

-- CreateIndex
CREATE INDEX "BackupRecord_createdAt_idx" ON "BackupRecord"("createdAt");

-- CreateIndex
CREATE INDEX "Alert_level_handleStatus_idx" ON "Alert"("level", "handleStatus");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE INDEX "Alert_dedupeKey_idx" ON "Alert"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notice_userId_readAt_idx" ON "Notice"("userId", "readAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserWorkspace_uuid_key" ON "BrowserWorkspace"("uuid");

-- CreateIndex
CREATE INDEX "BrowserWorkspace_userId_deletedAt_idx" ON "BrowserWorkspace"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "BrowserWorkspace_status_idx" ON "BrowserWorkspace"("status");

-- CreateIndex
CREATE INDEX "BrowserWorkspace_groupId_idx" ON "BrowserWorkspace"("groupId");

-- CreateIndex
CREATE INDEX "BrowserWorkspace_createdAt_idx" ON "BrowserWorkspace"("createdAt");

-- CreateIndex
CREATE INDEX "BrowserTemplate_scope_deletedAt_idx" ON "BrowserTemplate"("scope", "deletedAt");

-- CreateIndex
CREATE INDEX "BrowserTemplate_userId_idx" ON "BrowserTemplate"("userId");

-- CreateIndex
CREATE INDEX "BrowserProfileSnapshot_userId_deletedAt_idx" ON "BrowserProfileSnapshot"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "BrowserScriptTemplate_scope_deletedAt_idx" ON "BrowserScriptTemplate"("scope", "deletedAt");

-- CreateIndex
CREATE INDEX "DomainRule_scopeType_groupId_idx" ON "DomainRule"("scopeType", "groupId");

-- CreateIndex
CREATE INDEX "DomainRule_scopeType_userId_idx" ON "DomainRule"("scopeType", "userId");

-- CreateIndex
CREATE INDEX "DomainRule_scopeType_workspaceId_idx" ON "DomainRule"("scopeType", "workspaceId");

-- CreateIndex
CREATE INDEX "DomainRule_type_enabled_idx" ON "DomainRule"("type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceShare_workspaceId_targetUserId_key" ON "WorkspaceShare"("workspaceId", "targetUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceShareLink_token_key" ON "WorkspaceShareLink"("token");

-- CreateIndex
CREATE INDEX "WorkspaceShareLink_workspaceId_idx" ON "WorkspaceShareLink"("workspaceId");

-- CreateIndex
CREATE INDEX "SteelNode_status_idx" ON "SteelNode"("status");

-- CreateIndex
CREATE INDEX "ProxyNode_status_deletedAt_idx" ON "ProxyNode"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "ProxyNode_type_idx" ON "ProxyNode"("type");

-- CreateIndex
CREATE INDEX "ProxyUsage_proxyNodeId_sessionDate_idx" ON "ProxyUsage"("proxyNodeId", "sessionDate");

-- CreateIndex
CREATE INDEX "ProxyUsage_userId_sessionDate_idx" ON "ProxyUsage"("userId", "sessionDate");

-- CreateIndex
CREATE INDEX "HostNode_status_idx" ON "HostNode"("status");

-- CreateIndex
CREATE INDEX "SingboxInstance_status_deletedAt_idx" ON "SingboxInstance"("status", "deletedAt");

-- CreateIndex
CREATE INDEX "SingboxInstance_hostNodeId_idx" ON "SingboxInstance"("hostNodeId");

-- CreateIndex
CREATE INDEX "SingboxConfigVersion_instanceId_version_idx" ON "SingboxConfigVersion"("instanceId", "version");

-- CreateIndex
CREATE INDEX "SingboxStats_instanceId_recordedAt_idx" ON "SingboxStats"("instanceId", "recordedAt");

-- CreateIndex
CREATE INDEX "HarRecord_workspaceId_idx" ON "HarRecord"("workspaceId");

-- CreateIndex
CREATE INDEX "CdpRecording_workspaceId_idx" ON "CdpRecording"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "McpTask_taskUuid_key" ON "McpTask"("taskUuid");

-- CreateIndex
CREATE INDEX "McpTask_status_priority_idx" ON "McpTask"("status", "priority");

-- CreateIndex
CREATE INDEX "McpTask_userId_createdAt_idx" ON "McpTask"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpTaskItem_taskId_idx" ON "McpTaskItem"("taskId");

-- CreateIndex
CREATE INDEX "RecycleBin_resourceType_resourceId_idx" ON "RecycleBin"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "RecycleBin_ownerUserId_idx" ON "RecycleBin"("ownerUserId");

-- CreateIndex
CREATE INDEX "RecycleBin_purgeAt_idx" ON "RecycleBin"("purgeAt");

-- CreateIndex
CREATE INDEX "RiskListRule_type_value_idx" ON "RiskListRule"("type", "value");

-- CreateIndex
CREATE INDEX "RiskListRule_scopeType_groupId_idx" ON "RiskListRule"("scopeType", "groupId");

-- CreateIndex
CREATE INDEX "RiskListRule_scopeType_userId_idx" ON "RiskListRule"("scopeType", "userId");

-- CreateIndex
CREATE INDEX "RiskListRule_scopeType_workspaceId_idx" ON "RiskListRule"("scopeType", "workspaceId");

-- CreateIndex
CREATE INDEX "PolicyDeployment_status_createdAt_idx" ON "PolicyDeployment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PolicyDeployment_status_effectiveAt_idx" ON "PolicyDeployment"("status", "effectiveAt");

-- CreateIndex
CREATE INDEX "PolicyDeployment_createdByUserId_idx" ON "PolicyDeployment"("createdByUserId");

-- CreateIndex
CREATE INDEX "FilePolicyConfig_scopeType_scopeId_idx" ON "FilePolicyConfig"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "FilePolicyConfig_scopeId_idx" ON "FilePolicyConfig"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "FilePolicyConfig_scopeType_scopeId_key" ON "FilePolicyConfig"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "NetworkEndpointRule_scopeType_groupId_idx" ON "NetworkEndpointRule"("scopeType", "groupId");

-- CreateIndex
CREATE INDEX "NetworkEndpointRule_scopeType_userId_idx" ON "NetworkEndpointRule"("scopeType", "userId");

-- CreateIndex
CREATE INDEX "NetworkEndpointRule_scopeType_workspaceId_idx" ON "NetworkEndpointRule"("scopeType", "workspaceId");

-- CreateIndex
CREATE INDEX "NetworkEndpointRule_type_enabled_idx" ON "NetworkEndpointRule"("type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyTemplate_name_key" ON "PolicyTemplate"("name");

-- CreateIndex
CREATE INDEX "PolicyTemplate_builtin_idx" ON "PolicyTemplate"("builtin");

-- CreateIndex
CREATE INDEX "PolicyTemplate_deletedAt_idx" ON "PolicyTemplate"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserBehaviorProfile_userId_key" ON "UserBehaviorProfile"("userId");

-- CreateIndex
CREATE INDEX "Announcement_type_enabled_idx" ON "Announcement"("type", "enabled");

-- CreateIndex
CREATE INDEX "Announcement_enabled_endAt_idx" ON "Announcement"("enabled", "endAt");

-- CreateIndex
CREATE INDEX "AnnouncementDismiss_userId_dismissDate_idx" ON "AnnouncementDismiss"("userId", "dismissDate");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementDismiss_announcementId_userId_dismissDate_key" ON "AnnouncementDismiss"("announcementId", "userId", "dismissDate");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRead_announcementId_userId_key" ON "AnnouncementRead"("announcementId", "userId");

-- CreateIndex
CREATE INDEX "SystemSelfCheck_checkCode_createdAt_idx" ON "SystemSelfCheck"("checkCode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrxPlugin_crxId_key" ON "CrxPlugin"("crxId");

-- CreateIndex
CREATE INDEX "CrxPlugin_deletedAt_idx" ON "CrxPlugin"("deletedAt");

-- CreateIndex
CREATE INDEX "CrxPlugin_enabled_idx" ON "CrxPlugin"("enabled");

-- CreateIndex
CREATE INDEX "CrxPlugin_highRisk_idx" ON "CrxPlugin"("highRisk");

-- CreateIndex
CREATE INDEX "CrxPlugin_createdAt_idx" ON "CrxPlugin"("createdAt");

-- CreateIndex
CREATE INDEX "CrxPolicyEntry_scopeType_scopeId_idx" ON "CrxPolicyEntry"("scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "CrxPolicyEntry_crxId_idx" ON "CrxPolicyEntry"("crxId");

-- CreateIndex
CREATE UNIQUE INDEX "CrxPolicyEntry_scopeType_scopeId_crxId_key" ON "CrxPolicyEntry"("scopeType", "scopeId", "crxId");

-- CreateIndex
CREATE INDEX "CrxBlocklistEntry_crxId_idx" ON "CrxBlocklistEntry"("crxId");

-- CreateIndex
CREATE UNIQUE INDEX "CrxBlocklistEntry_scopeType_scopeId_crxId_key" ON "CrxBlocklistEntry"("scopeType", "scopeId", "crxId");

-- CreateIndex
CREATE INDEX "CrxInstallStatus_workspaceId_idx" ON "CrxInstallStatus"("workspaceId");

-- CreateIndex
CREATE INDEX "CrxInstallStatus_state_idx" ON "CrxInstallStatus"("state");

-- CreateIndex
CREATE INDEX "CrxInstallStatus_crxId_idx" ON "CrxInstallStatus"("crxId");

-- CreateIndex
CREATE UNIQUE INDEX "CrxInstallStatus_workspaceId_crxId_key" ON "CrxInstallStatus"("workspaceId", "crxId");

-- CreateIndex
CREATE INDEX "CrxGrayTask_status_idx" ON "CrxGrayTask"("status");

-- CreateIndex
CREATE INDEX "CrxGrayTask_createdAt_idx" ON "CrxGrayTask"("createdAt");

