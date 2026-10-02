import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ============================================================
// 密钥自愈（Node 上下文执行，绝不进入 Edge 编译）：
// 沙箱/容器重启后 boot 脚本可能把 .env 重置为最小集（仅 DATABASE_URL），
// 导致 NextAuth 路由侧与 proxy(middleware) 侧回落到不同的伪密钥 → 会话 cookie
// 两边解不开 → 登录后每个受保护页面都被踢回 /login（“重定向你太多次”）。
// 此处在 next.config 评估阶段（CLI 纯 Node 环境、先于服务器启动）补齐缺失密钥：
//   · 缺失 → 随机生成 → 注入 process.env（当前进程立即可用）
//   · 持久化写回 .env（下次启动直接可用；幂等）
// 仅自愈“应用自身”密钥；VNC_BRIDGE_SECRET / CRON_SECRET 与 mini-services 共享，
// 缺失时两侧使用同一字面量回退（生产由 docker/start.sh 生成注入），避免跨进程顺序竞态。
// 生产 standalone（server.js）不评估 next.config —— 生产密钥由 start.sh 负责。
// ============================================================
// 沙箱 SQLite 稳定路径自愈：/home/z/my-project 位于沙箱同步桥（ossfs/juicefs）
// 之上，DB 文件会被周期性替换（inode/dev 翻转）→ Prisma 连接池钉死旧句柄 →
// web 请求与 CLI/引擎任务各看各的数据（列表不一致 / 取票挂死）。
// 沙箱 dev（cwd 以 /home/z/my-project 开头）且 DATABASE_URL 指向项目内路径时，
// 统一重定向到不被同步层触碰的 /dev/shm/dockyard-db/custom.db（不存在则从项目路径迁移）。
// 生产 Docker（cwd=/app，DB 在容器卷内）不满足条件，行为不变。
try {
  const isSandboxDev = process.cwd().startsWith("/home/z/my-project");
  const dbUrl = process.env.DATABASE_URL || "";
  const m = dbUrl.match(/^file:\/(.+)$/);
  if (isSandboxDev && m && m[1].startsWith("/home/z/my-project")) {
    const stableDir = "/dev/shm/dockyard-db";
    const stablePath = `${stableDir}/custom.db`;
    const projectDb = m[1];
    try {
      fs.mkdirSync(stableDir, { recursive: true });
      if (!fs.existsSync(stablePath) && fs.existsSync(projectDb)) {
        fs.copyFileSync(projectDb, stablePath);
        console.log(`[next.config] 沙箱 DB 迁移：${projectDb} → ${stablePath}（规避 overlay 重挂载（dev 翻转））`);
      }
    } catch (e) {
      console.warn("[next.config] 沙箱 DB 迁移失败，沿用原路径：", String(e));
    }
    process.env.DATABASE_URL = `file:${stablePath}`;
    // 持久化到 .env（保证 bun CLI / mini-services 与 app 读到同一路径，避免再分裂）
    try {
      const envPath = path.join(process.cwd(), ".env");
      let txt = "";
      try { txt = fs.readFileSync(envPath, "utf8"); } catch { txt = ""; }
      const line = `DATABASE_URL=file:${stablePath}`;
      const re = /^DATABASE_URL=.*$/m;
      const next = re.test(txt) ? txt.replace(re, line) : `${txt.length > 0 && !txt.endsWith("\n") ? "\n" : ""}${txt}${line}\n`;
      if (next !== txt) fs.writeFileSync(envPath, next, { mode: 0o600 });
    } catch (e) {
      console.warn("[next.config] DATABASE_URL .env 持久化失败：", String(e));
    }
  }
} catch (e) {
  console.warn("[next.config] 沙箱 DB 路径自愈异常：", String(e));
}
try {
  const selfHealKeys: Array<[string, () => string]> = [
    ["AUTH_SECRET", () => crypto.randomBytes(48).toString("base64url")],
    ["ENCRYPTION_KEY", () => crypto.randomBytes(32).toString("base64url")],
  ];
  const envPath = path.join(process.cwd(), ".env");
  let envText = "";
  try {
    envText = fs.readFileSync(envPath, "utf8");
  } catch {
    envText = "";
  }
  let changed = false;
  for (const [key, gen] of selfHealKeys) {
    if (process.env[key]) continue;
    const value = gen();
    process.env[key] = value;
    changed = true;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(envText)) {
      envText = envText.replace(re, line);
    } else {
      envText += (envText.length > 0 && !envText.endsWith("\n") ? "\n" : "") + line + "\n";
    }
  }
  if (changed) {
    try {
      fs.writeFileSync(envPath, envText, { mode: 0o600 });
      console.log("[next.config] 检测到缺失密钥，已自动生成并写入 .env（AUTH_SECRET / ENCRYPTION_KEY）");
    } catch (e) {
      console.warn("[next.config] 密钥已注入当前进程，但 .env 持久化失败：", String(e));
    }
  }
} catch (e) {
  console.error("[next.config] 密钥自愈流程异常：", String(e));
}

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // ---- [22-d] PostgreSQL 双客户端支持 ----
  // @prisma/client-postgres 为独立生成产物（generator output → node_modules/@prisma/client-postgres），
  // 必须保持外部化：打包器改写其内部相对 require（查询引擎 .so.node 路径）会导致运行时
  // 「Unable to load query engine」。prisma/@prisma/client 本就在 Next 默认外部化清单中。
  serverExternalPackages: ["@prisma/client-postgres"],
  // 查询引擎为运行时动态路径 join 加载（NFT 无法静态追踪）→ 显式包含进 standalone 产物：
  // · node_modules/.prisma/client/**：SQLite 引擎（默认形态）
  // · node_modules/@prisma/client-postgres/**：PostgreSQL 引擎（DATABASE_PROVIDER=postgres）
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.prisma/client/**",
      "./node_modules/@prisma/client-postgres/**",
    ],
  },
};

export default nextConfig;
