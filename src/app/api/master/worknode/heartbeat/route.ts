import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { createHash, timingSafeEqual } from "crypto"
import { z } from "zod"

// ============================================================
// r29：Worker 心跳上报（Worker → Master）
// POST /api/master/worknode/heartbeat
//   Header: x-node-uuid + x-node-key（SHA-256 对账 timingSafeEqual）
//   Body: { cpu, mem, disk, diskFreeMb, sandboxCount, sandboxRunning, netInKbps, netOutKbps, version, hostname,
//           results?: [{ cmdId, ok, error?, data? }] —— r36：上轮指令执行结果回传 }
//   响应：指令队列（r36：WorkNodeCommand 待下发指令，含 id；备份副本推送等）
// 驱逐节点（EVICTED）→ 心跳永久拒绝 403
// ============================================================

const hbSchema = z.object({
  cpu: z.number().min(0).max(100).optional(),
  mem: z.number().min(0).max(100).optional(),
  disk: z.number().min(0).max(100).optional(),
  diskFreeMb: z.number().int().min(0).max(10_000_000).optional(),
  sandboxCount: z.number().int().min(0).max(10000).optional(),
  sandboxRunning: z.number().int().min(0).max(10000).optional(),
  netInKbps: z.number().min(0).max(10_000_000).optional(),
  netOutKbps: z.number().min(0).max(10_000_000).optional(),
  version: z.string().max(60).optional(),
  hostname: z.string().max(120).optional(),
  // r36：指令执行结果回传（限 64 条/次，字段受控）
  results: z.array(z.object({
    cmdId: z.string().max(64),
    ok: z.boolean(),
    error: z.string().max(500).optional(),
    data: z.unknown().optional(),
  })).max(64).optional(),
})

export async function POST(req: NextRequest) {
  try {
    const nodeUuid = req.headers.get("x-node-uuid") || ""
    const nodeKey = req.headers.get("x-node-key") || ""
    if (!/^wn-[a-f0-9]{16}$/.test(nodeUuid) || !/^wak-[a-f0-9]{48}$/.test(nodeKey)) {
      return NextResponse.json({ code: 40001, msg: "节点凭证格式非法" }, { status: 400 })
    }

    const node = await db.workNode.findUnique({ where: { nodeUuid } })
    if (!node) return NextResponse.json({ code: 40400, msg: "节点不存在（已在主控删除）" }, { status: 404 })
    if (node.status === "EVICTED") {
      return NextResponse.json({ code: 40300, msg: "该节点已被驱逐（密钥已失效），请部署新节点" }, { status: 403 })
    }
    if (!node.enabled) {
      return NextResponse.json({ code: 40300, msg: "该节点已被禁用" }, { status: 403 })
    }

    // SHA-256 对账（timingSafeEqual 防时序侧信道）
    const expect = Buffer.from(node.apiKeyHash, "hex")
    const got = Buffer.from(createHash("sha256").update(nodeKey).digest("hex"), "hex")
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
      await writeAudit({
        operationType: "WORKNODE_AUTH_FAIL", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
        after: { nodeUuid, via: "heartbeat", ts: new Date().toISOString() },
        severity: "DANGER",
      }).catch(() => null)
      return NextResponse.json({ code: 40300, msg: "API Key 校验失败" }, { status: 403 })
    }

    const body = await req.json().catch(() => ({}))
    const p = hbSchema.safeParse(body)
    if (!p.success) {
      return NextResponse.json({ code: 40001, msg: "心跳负载格式非法" }, { status: 400 })
    }

    const wasOffline = node.status !== "ONLINE"
    await db.workNode.update({
      where: { id: node.id },
      data: {
        status: "ONLINE",
        cpuUsage: p.data.cpu ?? node.cpuUsage,
        memUsage: p.data.mem ?? node.memUsage,
        diskUsage: p.data.disk ?? node.diskUsage,
        diskFreeMb: p.data.diskFreeMb ?? node.diskFreeMb,
        sandboxCount: p.data.sandboxCount ?? node.sandboxCount,
        sandboxRunning: p.data.sandboxRunning ?? node.sandboxRunning,
        netInKbps: p.data.netInKbps ?? node.netInKbps,
        netOutKbps: p.data.netOutKbps ?? node.netOutKbps,
        version: p.data.version ?? node.version,
        hostname: p.data.hostname ?? node.hostname,
        lastHeartbeatAt: new Date(),
      },
    })

    if (wasOffline) {
      await writeAudit({
        operationType: "WORKNODE_ONLINE", resourceType: "WORK_NODE", resourceId: node.id, resourceName: node.name,
        after: { nodeUuid, hostname: p.data.hostname, version: p.data.version },
        severity: "INFO",
      }).catch(() => null)
    }

    // ---- r36：指令执行结果回传（更新 WorkNodeCommand + 备份副本状态链）----
    if (p.data.results && p.data.results.length > 0) {
      for (const r of p.data.results) {
        try {
          const cmdRow = await db.workNodeCommand.findUnique({ where: { id: r.cmdId } })
          if (!cmdRow || cmdRow.nodeUuid !== nodeUuid || cmdRow.doneAt) continue // 防跨节点伪造/重复
          await db.workNodeCommand.update({
            where: { id: r.cmdId },
            data: { doneAt: new Date(), resultJson: JSON.stringify({ ok: r.ok, error: r.error, data: r.data ?? null }) },
          })
          // 备份副本链路：fail 的 finish 指令 → 对应 BackupRecord 副本状态置 FAIL
          if (!r.ok && cmdRow.cmd === "backup.replica.finish") {
            try {
              const payload = JSON.parse(cmdRow.payloadJson) as { backupId?: string }
              if (payload?.backupId) {
                const rec = await db.backupRecord.findUnique({ where: { id: payload.backupId } })
                if (rec?.replicasJson) {
                  const reps = JSON.parse(rec.replicasJson) as Array<{ nodeUuid: string; state: string; error?: string; at?: string }>
                  for (const rep of reps) {
                    if (rep.nodeUuid === nodeUuid) { rep.state = "FAIL"; rep.error = (r.error || "").slice(0, 200); rep.at = new Date().toISOString() }
                  }
                  await db.backupRecord.update({ where: { id: rec.id }, data: { replicasJson: JSON.stringify(reps) } })
                }
              }
            } catch { /* 副本状态链容错（不影响指令回执） */ }
          }
          // 成功 finish → 副本状态置 OK
          if (r.ok && cmdRow.cmd === "backup.replica.finish") {
            try {
              const payload = JSON.parse(cmdRow.payloadJson) as { backupId?: string }
              if (payload?.backupId) {
                const rec = await db.backupRecord.findUnique({ where: { id: payload.backupId } })
                if (rec?.replicasJson) {
                  const reps = JSON.parse(rec.replicasJson) as Array<{ nodeUuid: string; state: string; at?: string }>
                  for (const rep of reps) {
                    if (rep.nodeUuid === nodeUuid) { rep.state = "OK"; rep.at = new Date().toISOString() }
                  }
                  await db.backupRecord.update({ where: { id: rec.id }, data: { replicasJson: JSON.stringify(reps) } })
                }
              }
            } catch { /* 同上 */ }
          }
        } catch { /* 单条回执失败不阻断心跳 */ }
      }
    }

    // ---- r36：待下发指令队列（心跳携出；顺序保真：按创建时间升序，每次 ≤8 条）----
    const pending = await db.workNodeCommand.findMany({
      where: { nodeUuid, doneAt: null, sentAt: null },
      orderBy: { createdAt: "asc" },
      take: 8,
    })
    if (pending.length > 0) {
      await db.workNodeCommand.updateMany({
        where: { id: { in: pending.map((c) => c.id) } },
        data: { sentAt: new Date() },
      })
    }
    // 60s 未回执的已发指令 → 重置待发（Worker 瞬断容错；重试上限 5 次防死循环）
    const retryable = await db.workNodeCommand.findMany({
      where: { nodeUuid, doneAt: null, sentAt: { lt: new Date(Date.now() - 60_000) }, retries: { lt: 5 } },
      orderBy: { createdAt: "asc" },
      take: 8,
    })
    if (retryable.length > 0) {
      await db.workNodeCommand.updateMany({
        where: { id: { in: retryable.map((c) => c.id) } },
        data: { sentAt: null, retries: { increment: 1 } },
      })
    }

    const commands = [...pending, ...retryable].map((c) => ({
      id: c.id,
      cmd: c.cmd,
      payload: JSON.parse(c.payloadJson) as unknown,
    }))

    // 指令队列（Worker 执行指令的下行通道；含 r36 备份副本推送分块）
    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: {
        ackIntervalSec: 10,
        maxSandboxes: node.maxSandboxes,
        commands,
      },
    })
  } catch (e) {
    return NextResponse.json({ code: 50000, msg: `心跳处理失败：${(e as Error).message}` }, { status: 500 })
  }
}
