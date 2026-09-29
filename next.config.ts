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
};

export default nextConfig;
