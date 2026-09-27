// 种子数据：超管账号 / 默认配置 / 内置定时任务 / 默认Steel节点与宿主机
// 执行：bunx tsx prisma/seed.ts （或 bun prisma/seed.ts）
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { CONFIG_DEFAULTS } from "../src/lib/config"

const db = new PrismaClient()

async function main() {
  // ---- 播种系统配置 ----
  for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
    await db.systemConfig.upsert({
      where: { key },
      update: {},
      create: {
        key,
        valueJson: JSON.stringify(def.value),
        category: def.category,
        valueType: def.type,
        description: def.description,
      },
    })
  }
  console.log(`[seed] 系统配置 ${Object.keys(CONFIG_DEFAULTS).length} 项已就绪`)

  // ---- 超管账号 ----
  const adminPassword = process.env.ADMIN_PASSWORD || "Admin@2026"
  const admin = await db.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      email: "admin@dockyard.local",
      displayName: "超级管理员",
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: "SUPER_ADMIN",
      enabled: true,
      emailVerified: true,
    },
  })
  console.log(`[seed] 超管账号 admin 就绪（密码：${adminPassword}）`)

  // ---- 默认演示用户 ----
  const demoPassword = "Demo@2026"
  await db.user.upsert({
    where: { username: "demo" },
    update: {},
    create: {
      username: "demo",
      email: "demo@dockyard.local",
      displayName: "演示用户",
      passwordHash: await bcrypt.hash(demoPassword, 12),
      role: "USER",
      enabled: true,
      emailVerified: true,
      quota: { sessions: 5, novncSessions: 2, diskMb: 512 },
    },
  })
  console.log(`[seed] 演示用户 demo 就绪（密码：${demoPassword}）`)

  // ---- 默认用户组 ----
  const defaultGroup = await db.group.upsert({
    where: { name: "默认用户组" },
    update: {},
    create: {
      name: "默认用户组",
      description: "系统默认用户组",
      quota: { sessions: 20, novncSessions: 8, diskMb: 4096 },
      createdByUserId: admin.id,
    },
  })
  await db.groupUser.upsert({
    where: { groupId_userId: { groupId: defaultGroup.id, userId: admin.id } },
    update: {},
    create: { groupId: defaultGroup.id, userId: admin.id },
  })
  const demoUser = await db.user.findUnique({ where: { username: "demo" } })
  if (demoUser) {
    await db.groupUser.upsert({
      where: { groupId_userId: { groupId: defaultGroup.id, userId: demoUser.id } },
      update: {},
      create: { groupId: defaultGroup.id, userId: demoUser.id },
    })
  }

  // ---- 内置定时任务注册 ----
  const tasks: { code: string; name: string; cron: string; timeout: number }[] = [
    { code: "session_idle_reclaim", name: "会话闲置回收与TTL清理", cron: "*/5 * * * *", timeout: 120 },
    { code: "singbox_status_sync", name: "SingBox实例状态同步", cron: "*/2 * * * *", timeout: 120 },
    { code: "proxy_health_probe", name: "代理节点健康探测", cron: "*/3 * * * *", timeout: 120 },
    { code: "file_expire_clean", name: "过期文件清理", cron: "*/30 * * * *", timeout: 300 },
    { code: "db_backup", name: "数据库定时备份", cron: "0 3 * * *", timeout: 900 },
    { code: "log_archive", name: "日志归档", cron: "0 4 * * *", timeout: 600 },
    { code: "alert_state_check", name: "告警状态检测（条件恢复自动标记）", cron: "*/10 * * * *", timeout: 60 },
    { code: "zombie_reclaim", name: "僵死资源回收", cron: "*/5 * * * *", timeout: 180 },
    { code: "quota_check", name: "配额超限检测", cron: "*/15 * * * *", timeout: 60 },
    { code: "token_expire", name: "API-Token过期作废与到期告警", cron: "0 * * * *", timeout: 120 },
    { code: "recycle_purge", name: "回收站到期物理清除", cron: "*/10 * * * *", timeout: 120 },
    { code: "dirty_data_clean", name: "脏数据自动清洗自愈", cron: "*/15 * * * *", timeout: 180 },
    { code: "host_probe", name: "宿主机资源采集与水位告警", cron: "*/5 * * * *", timeout: 120 },
    { code: "config_drift", name: "配置漂移检测", cron: "*/5 * * * *", timeout: 60 },
    { code: "self_check", name: "平台智能自检", cron: "0 */1 * * *", timeout: 120 },
    { code: "share_expire", name: "过期共享授权清理", cron: "*/5 * * * *", timeout: 60 },
    { code: "novnc_health", name: "NoVNC会话健康探测与闲置回收", cron: "*/2 * * * *", timeout: 120 },
  ]
  for (const t of tasks) {
    await db.scheduleTask.upsert({
      where: { code: t.code },
      update: { name: t.name },
      create: { code: t.code, name: t.name, cronExpr: t.cron, enabled: true, timeoutSec: t.timeout },
    })
  }
  console.log(`[seed] 定时任务 ${tasks.length} 项已注册`)

  // ---- 默认 Steel 节点 + 宿主机 ----
  const steelCount = await db.steelNode.count()
  if (steelCount === 0) {
    await db.steelNode.create({
      data: {
        name: "steel-default",
        baseUrl: process.env.STEEL_BROWSER_URL || "http://steel-internal:3000",
        labels: ["default"],
        weight: 1,
        status: "ONLINE",
        grayGroup: "PROD",
      },
    })
  }
  const hostCount = await db.hostNode.count()
  if (hostCount === 0) {
    await db.hostNode.create({
      data: {
        name: "host-default",
        dockerApiUrl: process.env.DOCKER_API_URL || "http://docker-proxy:2375",
        cpuCores: 8,
        memTotalMb: 16384,
        reservedCpu: 1,
        reservedMemMb: 1024,
        status: "ONLINE",
      },
    })
  }

  // ---- 默认 UA 池 ----
  const uaCount = await db.uaRecord.count()
  if (uaCount === 0) {
    const uas = [
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome 126 Win"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "Chrome 126 Mac"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0", "Firefox 128 Win"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "Safari 17 Mac"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "Chrome 126 Android"],
    ] as const
    for (const [ua, label] of uas) {
      await db.uaRecord.create({ data: { ua, label, category: label.includes("Android") ? "MOBILE" : "DESKTOP" } })
    }
  }

  // ---- 演示浏览器模板 ----
  const tplCount = await db.browserTemplate.count()
  if (tplCount === 0) {
    await db.browserTemplate.create({
      data: {
        name: "通用浏览模板",
        description: "默认UA与时区的标准浏览会话",
        scope: "GLOBAL",
        configJson: JSON.stringify({
          ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          variables: {},
        }),
        createdByUserId: admin.id,
      },
    })
    await db.browserTemplate.create({
      data: {
        name: "移动端浏览模板",
        description: "移动UA模拟",
        scope: "GLOBAL",
        configJson: JSON.stringify({
          ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          variables: {},
        }),
        createdByUserId: admin.id,
      },
    })
  }

  console.log("[seed] 完成 ✓")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
