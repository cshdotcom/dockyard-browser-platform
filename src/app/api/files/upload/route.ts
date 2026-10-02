import { NextRequest, NextResponse } from "next/server"
import { promises as fsp } from "fs"
import path from "path"
import { db } from "@/lib/db"
import { apiHandler } from "@/lib/api"
import { requireAuth } from "@/lib/permissions"
import { rateLimit } from "@/lib/rate-limit"
import { writeAudit } from "@/lib/audit"
import { ENV } from "@/lib/env"
import { getConfig, getConfigBool, getConfigNumber } from "@/lib/config"
import { BizError, ErrorCode } from "@/lib/errors"

// ============================================================
// 文件上传（r23 补齐）：POST /api/files/upload（multipart/form-data，字段 files[]）
// 上传卡片此前指向本路由但路由缺失（上传 404 根因）—— 本轮补齐并接入全部 storage.* 配置：
//   · storage.allowedExtensions  扩展名白名单（逗号分隔，空=不限；拒绝时逐文件返回原因）
//   · storage.retentionDays      默认保留天数（写入 expireAt，到期由 file_expire_clean 任务回收）
//   · storage.quotaPerUserMb     单用户磁盘配额（已用+本次超限则整体拒绝）
//   · storage.quotaPerGroupMb    用户组配额（用户多组取最大值；超出拒绝）
//   · storage.virusScan          开关（开启时上传后标记待扫描，由 scanFileAction 处理）
// 权限：登录用户；限流 20 次/分钟；storageKey 落在 storage/files/<userId>/ 内；FILE_UPLOAD 审计
// ============================================================

const MAX_FILE_BYTES = 200 * 1024 * 1024 // 单文件 200MB
const MAX_BATCH = 10

export async function POST(req: NextRequest) {
  return apiHandler(async () => {
    const ctx = await requireAuth()
    // r23：强制 2FA 未完成时拒绝一切写操作（与 Server Action requireWritableMode 同语义；API-Key 机器通道不受影响）
    const { enforce2faCompliance } = await import("@/lib/permissions")
    await enforce2faCompliance()

    if (!rateLimit(`file-ul:${ctx.userId}`, 20, 60_000).allowed) {
      throw new BizError(ErrorCode.RATE_LIMITED, "上传过于频繁，请稍后再试")
    }

    const form = await req.formData().catch(() => null)
    if (!form) throw new BizError(ErrorCode.PARAM_ERROR, "请求必须是 multipart/form-data 格式")
    const files = form.getAll("files").filter((f): f is File => f instanceof File)
    if (files.length === 0) throw new BizError(ErrorCode.PARAM_ERROR, "缺少文件（字段名 files）")
    if (files.length > MAX_BATCH) throw new BizError(ErrorCode.PARAM_ERROR, `单批最多 ${MAX_BATCH} 个文件`)

    // ---- 配置读取（保存即生效：每次上传实时读取） ----
    const extWhitelistRaw = await getConfig<string>("storage.allowedExtensions", "")
    const extWhitelist = extWhitelistRaw.split(",").map((s) => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean)
    const retentionDays = await getConfigNumber("storage.retentionDays", 30)
    const quotaUserMb = await getConfigNumber("storage.quotaPerUserMb", 2048)
    const quotaGroupMb = await getConfigNumber("storage.quotaPerGroupMb", 20480)
    const virusScanEnabled = await getConfigBool("storage.virusScan", false)

    // ---- 配额检查（用户级 + 组级；管理员豁免） ----
    const isSuper = ctx.role === "SUPER_ADMIN"
    if (!isSuper) {
      const used = await db.fileMeta.aggregate({ where: { userId: ctx.userId, deletedAt: null, purgedAt: null }, _sum: { size: true } })
      const usedBytes = used._sum.size ?? 0
      const incomingBytes = files.reduce((a, f) => a + f.size, 0)
      if (quotaUserMb > 0 && usedBytes + incomingBytes > quotaUserMb * 1024 * 1024) {
        throw new BizError(ErrorCode.QUOTA_EXCEEDED, `个人磁盘配额不足：已用 ${(usedBytes / 1048576).toFixed(1)}MB / ${quotaUserMb}MB，本次需再上传 ${(incomingBytes / 1048576).toFixed(1)}MB`)
      }
      // 组配额：用户所属组的成员合计用量
      const gids = await db.groupUser.findMany({ where: { userId: ctx.userId }, select: { groupId: true } })
      if (gids.length > 0 && quotaGroupMb > 0) {
        const groups = await db.group.findMany({ where: { id: { in: gids.map((g) => g.groupId) }, deletedAt: null, enabled: true }, select: { id: true } })
        const memberIds = groups.length > 0 ? (await db.groupUser.findMany({ where: { groupId: { in: groups.map((g) => g.id) } }, select: { userId: true } })).map((m) => m.userId) : []
        if (memberIds.length > 0) {
          const groupUsed = await db.fileMeta.aggregate({ where: { userId: { in: memberIds }, deletedAt: null, purgedAt: null }, _sum: { size: true } })
          const groupUsedBytes = groupUsed._sum.size ?? 0
          const groupIncoming = files.reduce((a, f) => a + f.size, 0)
          if (groupUsedBytes + groupIncoming > quotaGroupMb * 1024 * 1024) {
            throw new BizError(ErrorCode.QUOTA_EXCEEDED, `用户组磁盘配额不足：组内已用 ${(groupUsedBytes / 1048576).toFixed(1)}MB / ${quotaGroupMb}MB`)
          }
        }
      }
    }

    // ---- 逐文件校验 + 落盘 + 建元数据 ----
    const dir = path.join(ENV.storageLocalPath, "files", ctx.userId)
    await fsp.mkdir(dir, { recursive: true })
    const uploaded: { id: string; fileName: string }[] = []
    const rejected: { fileName: string; reason: string }[] = []

    for (const file of files) {
      const safeName = file.name.replace(/[\/\\\0]/g, "_").slice(0, 180)
      try {
        if (file.size > MAX_FILE_BYTES) {
          rejected.push({ fileName: safeName, reason: `超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1048576)}MB` })
          continue
        }
        if (file.size === 0) {
          rejected.push({ fileName: safeName, reason: "空文件" })
          continue
        }
        const ext = safeName.includes(".") ? safeName.split(".").pop()!.toLowerCase() : ""
        if (extWhitelist.length > 0 && (!ext || !extWhitelist.includes(ext))) {
          rejected.push({ fileName: safeName, reason: `扩展名不在白名单（允许：${extWhitelist.join("、")}）` })
          continue
        }
        const id = crypto.randomUUID()
        const storedName = `${id}-${safeName}`
        const target = path.join(dir, storedName)
        // 路径穿越防护（理论不可达，双保险）
        if (!path.resolve(target).startsWith(path.resolve(ENV.storageLocalPath))) {
          rejected.push({ fileName: safeName, reason: "非法文件名" })
          continue
        }
        const buf = Buffer.from(await file.arrayBuffer())
        await fsp.writeFile(target, buf)
        const expireAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86400_000) : null
        const meta = await db.fileMeta.create({
          data: {
            fileName: safeName,
            storageKey: path.relative(ENV.storageLocalPath, target),
            size: file.size,
            mime: file.type || "application/octet-stream",
            category: "FILE",
            userId: ctx.userId,
            expireAt,
            virusScanned: !virusScanEnabled, // 开启病毒扫描时标记待扫描
          },
        })
        uploaded.push({ id: meta.id, fileName: safeName })
      } catch (e) {
        rejected.push({ fileName: safeName, reason: e instanceof Error ? e.message : "写入失败" })
      }
    }

    await writeAudit({
      operatorUserId: ctx.userId,
      operatorName: ctx.username,
      operationType: "FILE_UPLOAD",
      resourceType: "FILE",
      resourceId: uploaded.map((u) => u.id).join(",") || "(全部被拒)",
      resourceName: uploaded.map((u) => u.fileName).join(",").slice(0, 200) || "(空)",
      ownerUserId: ctx.userId,
      after: { uploaded: uploaded.length, rejected: rejected.length, totalBytes: files.reduce((a, f) => a + f.size, 0), rejectDetail: rejected.slice(0, 10) },
      severity: rejected.length > 0 && uploaded.length === 0 ? "WARN" : "INFO",
    })

    return NextResponse.json({
      code: 0,
      msg: "ok",
      data: { uploaded, rejected, quota: { userLimitMb: quotaUserMb, groupLimitMb: quotaGroupMb }, retentionDays },
      traceId: crypto.randomUUID(),
    })
  })
}
