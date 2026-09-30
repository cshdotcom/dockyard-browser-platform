// ============================================================
// CRX 安装调度引擎（上层业务，不修改 Chromium 内核）
// 状态机：PENDING → POLICY_APPLIED → INSTALLED
//         失败分支：PRIMARY_FAILED → BACKUP_RETRY → ALL_FAILED（停止自动重试，等手动）
//         版本锁定校验失败 → VERSION_MISMATCH（告警）
// 真实校验通道：
//   · 源可达性：fetch update_url（真实 HTTP/TCP 探测；商店源/私有镜像源均适用）
//   · 实际安装检测：容器 CDP Target.getTargets 枚举 browser-extension://<id>（真实容器）
//   · 演示/池模式：策略文件写入后标记 POLICY_APPLIED（真实容器启动后升级为 INSTALLED）
// 单插件故障隔离：逐插件独立 try/catch，A 插件失败不干扰其它扩展
// 告警：主源失败 / 双源失败 / 版本不匹配 / 高危插件运行（raiseAlert + webhookPayload）
// ============================================================

import { db } from "@/lib/db"
import { raiseAlert } from "@/lib/alerts"
import { writeAudit } from "@/lib/audit"
import { resolveWorkspaceCrxPolicy, type MergedCrxEntry } from "@/lib/crx-policy"

export interface TaskResultLike {
  itemsProcessed: number
  summary: string
}

const AUTO_RETRY_MAX = 3 // 单插件自动重试上限（超过等手动重试，防死循环）

// ---- 源可达性探测（真实 HTTP 请求，8 秒超时） ----
async function probeUpdateUrl(url: string): Promise<{ reachable: boolean; httpStatus: number | null; version: string | null; error?: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Dockyard-CRX-Poller/1.0" } })
    const body = res.ok ? (await res.text().catch(() => "")) : ""
    // Chromium update manifest（OMA 响应）：version="1.2.3.4" 属性解析（可选）
    const vm = /version="([0-9.]+)"/.exec(body)
    return { reachable: res.ok, httpStatus: res.status, version: vm ? vm[1] : null }
  } catch (e) {
    return { reachable: false, httpStatus: null, version: null, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// ---- 真实容器扩展检测（CDP Target.getTargets → browser-extension://<id>） ----
async function detectInstalledExtensions(cdpUrl: string): Promise<Map<string, string> | null> {
  // cdpUrl 形如 ws://ip:9222/devtools/browser/<uuid>；转 HTTP /json/list（WS 端点不可用时降级 null）
  try {
    const httpUrl = cdpUrl.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "") + "/json/list"
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const targets = (await res.json().catch(() => [])) as Array<{ url?: string; title?: string; type?: string }>
    const out = new Map<string, string>()
    for (const t of targets) {
      const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(t.url || "")
      if (m) out.set(m[1], t.title || "")
    }
    return out
  } catch {
    return null
  }
}

// ---- 单插件状态推进（安装调度核心） ----
async function advancePluginStatus(ws: { id: string; name: string; cdpUrl: string | null; containerRef: string | null; mode: string }, entry: MergedCrxEntry): Promise<string> {
  const existing = await db.crxInstallStatus.findUnique({ where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } } })

  // 终态保护：INSTALLED / ALL_FAILED / POLICY_APPLIED（无容器演示态）不自动推进
  if (existing && ["INSTALLED", "ALL_FAILED", "POLICY_APPLIED"].includes(existing.state) && existing.state !== "VERSION_MISMATCH") {
    // INSTALLED 也要复核版本锁定
    if (existing.state === "INSTALLED" && entry.lockedVersion && existing.currentVersion && existing.currentVersion !== entry.lockedVersion) {
      await db.crxInstallStatus.update({
        where: { id: existing.id },
        data: { state: "VERSION_MISMATCH", lastErrorCode: `锁定 ${entry.lockedVersion} ≠ 实际 ${existing.currentVersion}`, lastErrorAt: new Date(), lastCheckedAt: new Date() },
      })
      await raiseAlert({
        title: `CRX 锁定版本校验失败：${entry.crxId.slice(0, 8)}…`,
        level: "WARNING",
        content: `沙箱 ${ws.name} 的插件 ${entry.crxId} 实际运行版本 ${existing.currentVersion} 与策略锁定版本 ${entry.lockedVersion} 不一致`,
        resourceType: "WORKSPACE", resourceId: ws.id,
        dedupeKey: `crx-ver-${ws.id}-${entry.crxId}`,
        webhookPayload: { event: "crx.version_mismatch", workspaceId: ws.id, workspaceName: ws.name, crxId: entry.crxId, locked: entry.lockedVersion, actual: existing.currentVersion },
      })
      return "VERSION_MISMATCH"
    }
    return existing.state
  }

  const attempts = existing?.attempts ?? 0

  // 1) 主源可达性探测
  const primary = await probeUpdateUrl(entry.updateUrl)
  if (primary.reachable) {
    // 2) 真实容器 → CDP 枚举扩展（升级为 INSTALLED）
    if (ws.cdpUrl && ws.containerRef) {
      const installed = await detectInstalledExtensions(ws.cdpUrl)
      if (installed?.has(entry.crxId)) {
        await db.crxInstallStatus.upsert({
          where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
          create: { workspaceId: ws.id, crxId: entry.crxId, state: "INSTALLED", currentVersion: primary.version, sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1 },
          update: { state: "INSTALLED", currentVersion: primary.version, sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), lastErrorCode: null, attempts: attempts + 1 },
        })
        // 高危插件运行告警（检测到高危权限扩展真实安装）
        if (entry.highRisk) {
          await raiseAlert({
            title: `沙箱运行高危权限 CRX 扩展：${entry.crxId.slice(0, 8)}…`,
            level: "WARNING",
            content: `沙箱 ${ws.name} 已安装高危权限插件 ${entry.crxId}（主源 ${entry.updateUrl}），请核对该插件的权限范围是否符合安全基线`,
            resourceType: "WORKSPACE", resourceId: ws.id,
            dedupeKey: `crx-highrisk-${ws.id}-${entry.crxId}`,
            webhookPayload: { event: "crx.high_risk_installed", workspaceId: ws.id, workspaceName: ws.name, crxId: entry.crxId, updateUrl: entry.updateUrl },
          })
        }
        return "INSTALLED"
      }
      // 容器在但扩展未出现：策略已下发，等待 Chromium 下次启动拉取（受浏览器运行状态约束）
      await db.crxInstallStatus.upsert({
        where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
        create: { workspaceId: ws.id, crxId: entry.crxId, state: "POLICY_APPLIED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date() },
        update: { state: "POLICY_APPLIED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date() },
      })
      return "POLICY_APPLIED"
    }
    // 3) 演示/池模式：策略下发即 POLICY_APPLIED（Managed Preferences 已生成）
    await db.crxInstallStatus.upsert({
      where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
      create: { workspaceId: ws.id, crxId: entry.crxId, state: "POLICY_APPLIED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date() },
      update: { state: "POLICY_APPLIED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1 },
    })
    return "POLICY_APPLIED"
  }

  // 4) 主源失败 → 备用源降级
  if (entry.backupUpdateUrl) {
    const backup = await probeUpdateUrl(entry.backupUpdateUrl)
    if (backup.reachable) {
      await db.crxInstallStatus.upsert({
        where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
        create: { workspaceId: ws.id, crxId: entry.crxId, state: "BACKUP_RETRY", sourceUsed: entry.backupUpdateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: `主源失败 HTTP ${primary.httpStatus ?? "ERR"}`, lastErrorAt: new Date() },
        update: { state: "BACKUP_RETRY", sourceUsed: entry.backupUpdateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: `主源失败 HTTP ${primary.httpStatus ?? "ERR"}，已切换备用源`, lastErrorAt: new Date() },
      })
      await writeAudit({
        operationType: "CRX_SOURCE_FAILOVER", resourceType: "CRX_PLUGIN", resourceId: entry.crxId,
        severity: "WARN",
        after: { workspaceId: ws.id, workspaceName: ws.name, crxId: entry.crxId, primaryUrl: entry.updateUrl, primaryError: primary.error || `HTTP ${primary.httpStatus}`, backupUrl: entry.backupUpdateUrl },
      })
      return "BACKUP_RETRY"
    }
    // 5) 双源全部失败
    const terminal = attempts + 1 >= AUTO_RETRY_MAX
    await db.crxInstallStatus.upsert({
      where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
      create: { workspaceId: ws.id, crxId: entry.crxId, state: terminal ? "ALL_FAILED" : "PRIMARY_FAILED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: `主源 HTTP ${primary.httpStatus ?? "ERR"} / 备源 HTTP ${backup.httpStatus ?? "ERR"}`, lastErrorAt: new Date() },
      update: { state: terminal ? "ALL_FAILED" : "PRIMARY_FAILED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: `主源 HTTP ${primary.httpStatus ?? "ERR"} / 备源 HTTP ${backup.httpStatus ?? "ERR"}`, lastErrorAt: new Date() },
    })
    if (terminal) {
      await raiseAlert({
        title: `CRX 插件主备源全部安装失败：${entry.crxId.slice(0, 8)}…`,
        level: "CRITICAL",
        content: `沙箱 ${ws.name} 的插件 ${entry.crxId} 主源（${entry.updateUrl}）与备用源（${entry.backupUpdateUrl}）均不可达，已停止自动重试，请人工排查或手动重试`,
        resourceType: "WORKSPACE", resourceId: ws.id,
        dedupeKey: `crx-allfail-${ws.id}-${entry.crxId}`,
        webhookPayload: { event: "crx.install_all_failed", workspaceId: ws.id, workspaceName: ws.name, crxId: entry.crxId, primaryUrl: entry.updateUrl, backupUrl: entry.backupUpdateUrl, httpPrimary: primary.httpStatus, httpBackup: backup.httpStatus },
      })
    }
    return terminal ? "ALL_FAILED" : "PRIMARY_FAILED"
  }

  // 6) 仅主源且失败
  const terminal = attempts + 1 >= AUTO_RETRY_MAX
  await db.crxInstallStatus.upsert({
    where: { workspaceId_crxId: { workspaceId: ws.id, crxId: entry.crxId } },
    create: { workspaceId: ws.id, crxId: entry.crxId, state: terminal ? "ALL_FAILED" : "PRIMARY_FAILED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: primary.error || `HTTP ${primary.httpStatus}`, lastErrorAt: new Date() },
    update: { state: terminal ? "ALL_FAILED" : "PRIMARY_FAILED", sourceUsed: entry.updateUrl, resolvedBy: entry.resolvedBy, lastCheckedAt: new Date(), attempts: attempts + 1, lastErrorCode: primary.error || `HTTP ${primary.httpStatus}`, lastErrorAt: new Date() },
  })
  if (terminal) {
    await raiseAlert({
      title: `CRX 插件安装失败（无备用源）：${entry.crxId.slice(0, 8)}…`,
      level: "CRITICAL",
      content: `沙箱 ${ws.name} 的插件 ${entry.crxId} 主源 ${entry.updateUrl} 不可达且未配置备用源，已停止自动重试`,
      resourceType: "WORKSPACE", resourceId: ws.id,
      dedupeKey: `crx-fail-${ws.id}-${entry.crxId}`,
      webhookPayload: { event: "crx.install_primary_failed", workspaceId: ws.id, workspaceName: ws.name, crxId: entry.crxId, primaryUrl: entry.updateUrl, httpPrimary: primary.httpStatus },
    })
  }
  return terminal ? "ALL_FAILED" : "PRIMARY_FAILED"
}

// ---- 任务 1：CRX 安装状态轮询（每分钟；冻结沙箱跳过） ----
export async function crxInstallPoll(log: (m: string) => void): Promise<TaskResultLike> {
  const workspaces = await db.browserWorkspace.findMany({
    where: { status: { in: ["RUNNING", "IDLE"] }, deletedAt: null, mode: { in: ["cdp_light", "novnc_full"] } },
    select: { id: true, name: true, cdpUrl: true, containerRef: true, mode: true },
    take: 200, // 单轮上限（控制耗时）
  })
  let processed = 0
  let installed = 0
  for (const ws of workspaces) {
    try {
      const policy = await resolveWorkspaceCrxPolicy(ws.id)
      // 插件库被禁用但仍有沙箱引用 → 告警
      const disabledRefs = policy.entries.filter((e) => e.disabled)
      for (const d of disabledRefs) {
        await raiseAlert({
          title: `CRX 插件库已禁用但仍被沙箱引用：${d.crxId.slice(0, 8)}…`,
          level: "WARNING",
          content: `插件 ${d.crxId} 在库内已禁用，但沙箱 ${ws.name} 的策略链仍引用该插件，已暂停安装`,
          resourceType: "WORKSPACE", resourceId: ws.id,
          dedupeKey: `crx-libdisabled-${d.crxId}`,
          webhookPayload: { event: "crx.library_disabled_referenced", crxId: d.crxId, workspaceId: ws.id, workspaceName: ws.name },
        })
      }
      for (const entry of policy.entries.filter((e) => !e.disabled)) {
        // 单插件故障隔离：独立 try/catch
        try {
          const state = await advancePluginStatus(ws, entry)
          processed++
          if (state === "INSTALLED" || state === "POLICY_APPLIED") installed++
          log(`${ws.name} · ${entry.crxId.slice(0, 8)}… → ${state}`)
        } catch (e) {
          log(`插件状态推进异常（不影响其它插件）：${entry.crxId} ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // 沙箱当前策略不再包含的插件状态 → 标记移除（软清理，保留历史）
      await db.crxInstallStatus.updateMany({
        where: { workspaceId: ws.id, crxId: { notIn: policy.entries.map((e) => e.crxId) }, state: { in: ["PENDING", "POLICY_APPLIED", "BACKUP_RETRY"] } },
        data: { state: "REMOVED", lastCheckedAt: new Date() },
      }).catch(() => { /* 非关键 */ })
    } catch (e) {
      log(`沙箱策略解析失败（跳过）：${ws.name} ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { itemsProcessed: processed, summary: `轮询 ${workspaces.length} 个沙箱，推进 ${processed} 个插件状态，其中 ${installed} 个安装/下发成功` }
}

// ---- 任务 2：CRX 灰度滚动下发（每分钟；ROLLING → 批量应用 → SUCCESS/PARTIAL） ----
export async function crxGrayRollout(log: (m: string) => void): Promise<TaskResultLike> {
  const tasks = await db.crxGrayTask.findMany({
    where: { status: { in: ["PENDING", "ROLLING"] } },
    orderBy: { createdAt: "asc" },
    take: 10,
  })
  let processed = 0
  for (const task of tasks) {
    try {
      const entries = JSON.parse(task.entriesJson) as Array<{ crxId: string; updateUrl?: string; lockedVersion?: string; allowIncognito?: boolean; allowUserDisable?: boolean }>
      const targets = (Array.isArray(task.targetIds) ? task.targetIds : []) as string[]
      if (task.status === "PENDING") {
        await db.crxGrayTask.update({ where: { id: task.id }, data: { status: "ROLLING", activatedAt: new Date() } })
      }
      const batch = targets.slice(task.progressed, task.progressed + task.batchSize)
      let ok = 0
      let fail = 0
      for (const workspaceId of batch) {
        try {
          // 为灰度沙箱写入 SANDBOX 级单插件策略（浏览器停止状态下生效）
          for (const e of entries) {
            await db.crxPolicyEntry.upsert({
              where: { scopeType_scopeId_crxId: { scopeType: "SANDBOX", scopeId: workspaceId, crxId: e.crxId } },
              create: { scopeType: "SANDBOX", scopeId: workspaceId, crxId: e.crxId, updateUrl: e.updateUrl || null, lockedVersion: e.lockedVersion || null, allowIncognito: e.allowIncognito ?? null, allowUserDisable: e.allowUserDisable ?? null, note: `灰度任务 ${task.name}`, createdByUserId: task.createdByUserId, createdByName: task.createdByName },
              update: { updateUrl: e.updateUrl || null, lockedVersion: e.lockedVersion || null, allowIncognito: e.allowIncognito ?? null, allowUserDisable: e.allowUserDisable ?? null, deletedAt: null },
            })
          }
          // 重置安装状态 → 等待轮询任务真实校验
          await db.crxInstallStatus.updateMany({ where: { workspaceId, crxId: { in: entries.map((e) => e.crxId) } }, data: { state: "PENDING", attempts: 0, lastErrorCode: null } })
          ok++
        } catch (e) {
          fail++
          log(`灰度沙箱应用失败：${workspaceId} ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const progressed = task.progressed + batch.length
      const done = progressed >= targets.length
      await db.crxGrayTask.update({
        where: { id: task.id },
        data: {
          progressed,
          successCount: task.successCount + ok,
          failCount: task.failCount + fail,
          status: done ? (task.failCount + fail > 0 ? "PARTIAL" : "SUCCESS") : "ROLLING",
          finishedAt: done ? new Date() : null,
        },
      })
      // 灰度部分失败 → 告警
      if (fail > 0) {
        await raiseAlert({
          title: `CRX 灰度下发部分失败：${task.name}`,
          level: "WARNING",
          content: `灰度任务 ${task.name} 本批次 ${batch.length} 个沙箱中 ${fail} 个应用失败`,
          resourceType: "CRX_GRAY_TASK", resourceId: task.id,
          dedupeKey: `crx-gray-fail-${task.id}`,
          webhookPayload: { event: "crx.gray_partial_failure", taskId: task.id, taskName: task.name, failed: fail, batch: batch.length },
        })
      }
      processed += batch.length
      log(`灰度 ${task.name}：本批 ${batch.length}（成功 ${ok} / 失败 ${fail}），总进度 ${progressed}/${targets.length}`)
    } catch (e) {
      log(`灰度任务异常：${task.name} ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { itemsProcessed: processed, summary: `灰度滚动推进 ${processed} 个沙箱批次` }
}
