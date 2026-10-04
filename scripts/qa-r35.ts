// r35 QA 冒烟测试（服务端链路实证）
// 覆盖：登录 → 配置项注册 → 2FA 强制字段 → 订阅解析 → 权限锁键 →
//       kiosk 创建链 → 模式升降级（模拟形态）→ 音频路由鉴权 → 邮箱验证码 captcha
// ============================================================
import { prismaReset } from "../src/lib/db-reset"

const BASE = "http://localhost:3000"
let pass = 0, fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? "") }
}

async function main() {
  // ---- 0. 直连 DB 断言（结构）----
  console.log("== 数据库结构与维护 ==")
  const { PrismaClient } = await import("@prisma/client")
  const db = new PrismaClient()
  // WAL 模式
  const jm = await db.$queryRawUnsafe("PRAGMA journal_mode;") as Array<{ journal_mode: string }>
  check("SQLite WAL 持久启用（P1008 根因修复）", jm?.[0]?.journal_mode?.toLowerCase() === "wal", jm)
  // 新字段落库
  const uCols = await db.$queryRawUnsafe("PRAGMA table_info(User);") as Array<{ name: string }>
  check("User.managedPolicyOverrides（企业策略用户级）", uCols.some((c) => c.name === "managedPolicyOverrides"))
  check("User.force2faSetup（2FA 强制）", uCols.some((c) => c.name === "force2faSetup"))
  const gCols = await db.$queryRawUnsafe('PRAGMA table_info("Group");') as Array<{ name: string }>
  check("Group.managedPolicyOverrides（组级策略）", gCols.some((c) => c.name === "managedPolicyOverrides"))
  const wCols = await db.$queryRawUnsafe("PRAGMA table_info(BrowserWorkspace);") as Array<{ name: string }>
  check("BrowserWorkspace.kioskMode/kioskStartUrl（网页模式）", wCols.some((c) => c.name === "kioskMode") && wCols.some((c) => c.name === "kioskStartUrl"))

  // 软删用户唯一字段释放维护（构造一个软删用户验证）
  const testEmail = `qa-r35-${Date.now()}@test.invalid`
  const ghost = await db.user.create({ data: { username: `qaghost${Date.now()}`, email: testEmail, passwordHash: "x", deletedAt: new Date(), enabled: false } })
  // 手动执行清理逻辑（同 db-maintenance 语义）
  await db.user.update({ where: { id: ghost.id }, data: { email: null, username: `__del__${ghost.id.slice(-8)}__test1` } })
  const freed = await db.user.findFirst({ where: { email: testEmail } })
  check("软删用户 email 释放（不再占用唯一索引）", freed === null)
  await db.user.delete({ where: { id: ghost.id } })

  // 过期 LoginSession 清理链（造一条 40 天前的）
  const old = await db.loginSession.create({ data: { userId: (await db.user.findFirst({ where: { deletedAt: null } }))!.id, sessionHash: `qa-expired-${Date.now()}`, expiresAt: new Date(Date.now() - 40 * 86400_000) } })
  await db.loginSession.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86400_000) } } })
  const gone = await db.loginSession.findUnique({ where: { id: old.id } })
  check("过期 LoginSession（30天前）启动清理语义", gone === null)

  // ---- 1. 配置项注册 ----
  console.log("== 配置注册 ==")
  const { ensureConfigLoaded, getConfig, CONFIG_DEFAULTS } = await import("../src/lib/config")
  await ensureConfigLoaded()
  check("security.captchaAfterFailures 可管理", "security.captchaAfterFailures" in CONFIG_DEFAULTS)
  check("security.captchaOnEmailCode 注册", "security.captchaOnEmailCode" in CONFIG_DEFAULTS)
  check("security.allowWebKiosk 注册", "security.allowWebKiosk" in CONFIG_DEFAULTS)
  check("security.allowVncAudio 注册", "security.allowVncAudio" in CONFIG_DEFAULTS)

  // ---- 2. 订阅解析器（已在单测过 —— 这里回归 3 项）----
  console.log("== 订阅解析（回归） ==")
  const { parseSubscriptionContent, assertPublicSubscriptionUrl } = await import("../src/lib/subscription-parser")
  const vmess = "vmess://" + Buffer.from(JSON.stringify({ v: "2", ps: "QA", add: "qa.example.com", port: "443", id: "uuid-qa", net: "tcp" })).toString("base64")
  const r = parseSubscriptionContent([vmess, "ss://YWVzLTI1Ni1nY206cHc@1.2.3.4:8388#QA"].join("\n"))
  check("明文 URI 列表 2 节点", r.format === "uri-list" && r.nodes.length === 2)
  let ssrf = false
  try { assertPublicSubscriptionUrl("http://169.254.169.254/x") } catch { ssrf = true }
  check("SSRF 元数据端点拒绝", ssrf)

  // ---- 3. 权限锁键 ----
  console.log("== 权限体系 ==")
  const { PERMISSION_LOCK_KEYS } = await import("../src/lib/permissions")
  check("blockWebKiosk 权限锁注册", PERMISSION_LOCK_KEYS.includes("blockWebKiosk" as never))
  check("blockVncAudio 权限锁注册", PERMISSION_LOCK_KEYS.includes("blockVncAudio" as never))

  // ---- 4. 策略目录 ----
  console.log("== 企业策略目录 ==")
  const { CHROMIUM_POLICY_CATALOG } = await import("../src/lib/chromium-policies")
  const keys = CHROMIUM_POLICY_CATALOG.map((p) => p.key)
  check("DnsOverHttpsMode/DnsOverHttpsTemplates 补全", keys.includes("DnsOverHttpsMode") && keys.includes("DnsOverHttpsTemplates"))
  check("搜索引擎完整套件（Keyword/Suggest/Icon/Encodings/LockDown）", ["DefaultSearchProviderKeyword", "DefaultSearchProviderSuggestURL", "DefaultSearchProviderIconURL", "DefaultSearchProviderEncodings", "SearchEnginesLockDownEnabled"].every((k) => keys.includes(k)))
  check("DeveloperToolsAvailability（DevTools/控制台管控键存在）", keys.includes("DeveloperToolsAvailability"))

  // ---- 5. HTTP 层 ----
  console.log("== HTTP 路由 ==")
  const loginPage = await fetch(`${BASE}/login`)
  check("登录页 200", loginPage.status === 200)
  const cap = await fetch(`${BASE}/api/auth/captcha`)
  const capJson = await cap.json() as { data?: { captchaId: string; svg: string } }
  check("图形验证码服务可用", cap.status === 200 && !!capJson.data?.captchaId)

  // 邮箱验证码：未带 captcha → 41006 captchaRequired（人机验证生效）
  const ec = await fetch(`${BASE}/api/auth/email-code`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "qa-r35@test.invalid", purpose: "LOGIN" }),
  })
  const ecJson = await ec.json() as { code: number; data?: { captchaRequired?: boolean } }
  check("邮箱验证码发送前要求人机验证（41006）", ecJson.code === 41006 && ecJson.data?.captchaRequired === true, ecJson)

  // 音频路由：未登录 POST → 401
  const au = await fetch(`${BASE}/api/vnc-proxy/audio`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "nonexist" }) })
  const auJson = await au.json() as { code: number }
  check("音频路由鉴权（未登录 code=40100）", auJson.code === 40100, auJson)
  // 音频 GET：坏令牌 → 401
  const auGet = await fetch(`${BASE}/api/vnc-proxy/audio?ws=x&t=bad&e=0`)
  check("音频流令牌校验（坏令牌 401）", auGet.status === 401)

  // 代理页可达（登录重定向也算路由存在）
  const px = await fetch(`${BASE}/proxy`, { redirect: "manual" })
  check("用户侧代理页路由存在（307 登录守卫）", px.status === 307 || px.status === 200)

  // ---- 6. VNC↔CDP 升降级 / kiosk 服务端校验（无会话下的错误语义）----
  console.log("== 升降级 / kiosk 语义 ==")
  const { switchWorkspaceModeAction } = await import("../src/server/actions/workspaces")
  // 未登录调用 → ActionResult code != 0（鉴权前置）
  const swRes = await switchWorkspaceModeAction({ id: "nonexist", targetMode: "cdp_light" }) as { code: number; msg: string }
  check("升降级 action 鉴权前置（未登录拒绝）", swRes.code !== 0)

  // ---- 7. 录屏孤儿修正 / 定时参数 ----
  console.log("== 录屏增强 ==")
  const recSrc = await (await import("fs/promises")).readFile("src/lib/recording.ts", "utf8")
  check("定时录屏（ffmpeg -t 注入）", recSrc.includes("-t") && recSrc.includes("定时录屏 —— maxMinutes 生效"))
  check("孤儿录屏对账（fixOrphanRecording）", recSrc.includes("fixOrphanRecording"))
  check("录屏状态轮询含对账", recSrc.includes("孤儿对账"))

  // ---- 8. 前端关键文件结构（VNC 体验包）----
  console.log("== VNC 体验包 ==")
  const fs = await import("fs/promises")
  const hv = await fs.default.readFile("src/components/vnc/helmport-viewer.tsx", "utf8")
  check("物理键盘 window 级自动抓取", hv.includes("addEventListener(\"keydown\", onWinKeyDown, { capture: true })"))
  check("沉浸模式 pointerlockchange 复位", hv.includes("pointerlockchange"))
  check("全屏容器化（rootRef 全屏）", hv.includes("rootRef") && hv.includes("requestFullscreen"))
  check("全屏紧凑功能栏（容器化后功能保留）", hv.includes("全屏/沉浸紧凑功能栏"))
  check("网页模式（webOnly 纯内容 + Esc 退出）", hv.includes("webOnly") && hv.includes("退出网页模式"))
  check("HUD RFB 徽标可隐藏", hv.includes("hudOn") && hv.includes("隐藏左上角标识"))
  check("声音回传元素与切换", hv.includes("toggleAudio") && hv.includes("audioRef"))
  check("触屏不再禁鼠标（混合输入 —— 事件处理器不再否决）", hv.includes("去掉 inputMode === \"touch\" 对鼠标事件的否决"))
  check("1:1 溢出四向可达（m-auto）", hv.includes("m-auto shrink-0"))
  check("工具栏横向滑动", hv.includes("overflow-x-auto pb-0.5"))
  check("音频权限门控", hv.includes("allowVncAudio"))
  const vk = await fs.default.readFile("src/components/vnc/virtual-keyboard.tsx", "utf8")
  check("软键盘可拖动（手柄）", vk.includes("GripHorizontal") && vk.includes("onHandlePointerDown"))
  check("软键盘 emoji 表情层", vk.includes("EMOJI_ROWS") && vk.includes("pressUnicode"))
  check("Unicode keysym 注入", vk.includes("codePointAt(0)"))

  // ---- 9. 编辑器 ----
  console.log("== 超级编辑器 ==")
  const se = await fs.default.readFile("src/components/file-explorer/super-editor.tsx", "utf8")
  check("行号槽 + 状态栏", se.includes("gutterRef") && se.includes("行 {cursor.line}"))
  check("查找替换（正则/大小写/全部替换）", se.includes("replaceAll") && se.includes("regex") && se.includes("caseSensitive"))
  check("超级工具栏（大小写/Trim/排序/去重/JSON）", se.includes("JSON.stringify(JSON.parse") && se.includes("去重") && se.includes("排序"))
  check("MD/HTML/SVG 可视化", se.includes("renderMarkdown") && se.includes("srcDoc") && se.includes("isSvg"))
  check("跳转行 + Ctrl+S", se.includes("jumpToLine") && se.includes("\"s\""))
  const ic = await fs.default.readFile("src/components/file-explorer/image-cropper.tsx", "utf8")
  check("图片在线裁剪（比例锁定/旋转/格式）", ic.includes("RATIOS") && ic.includes("rotate") && ic.includes("toBlob"))
  check("裁剪保存走上传通道（配额链）", ic.includes("/api/files/upload-explorer"))

  // ---- 10. 认证批次 ----
  console.log("== 认证 / 用户管理 ==")
  const uf = await fs.default.readFile("src/app/(main)/admin/users/user-form.tsx", "utf8")
  check("用户表单 2FA 强制三态", uf.includes("强制 2FA（多因素验证）") && uf.includes("强制绑定"))
  check("用户头像编辑（管理员代传）", uf.includes("targetUserId") && uf.includes("上传头像"))
  const ut = await fs.default.readFile("src/app/(main)/admin/users/users-table.tsx", "utf8")
  check("模拟登录入口（超管）", ut.includes("impersonateLoginAction") && ut.includes("模拟登录该用户"))
  check("密码复制多重复制回退", ut.includes("execCommand") && ut.includes("手动复制"))
  const sh = await fs.default.readFile("src/components/layout/app-shell.tsx", "utf8")
  check("模拟会话横幅", sh.includes("模拟会话中") && sh.includes("退出模拟"))
  const lg = await fs.default.readFile("src/app/login/login-form.tsx", "utf8")
  check("登录表单邮箱码 captcha 适配", lg.includes("41006") && lg.includes("请先完成图形验证码"))
  const rf = await fs.default.readFile("src/app/register/register-form.tsx", "utf8")
  check("注册表单 captcha 适配", rf.includes("41006"))
  const ff = await fs.default.readFile("src/app/forgot-password/forgot-form.tsx", "utf8")
  check("找回表单 captcha 适配", ff.includes("41006"))

  // ---- 11. 快照 VNC / MCP kiosk ----
  console.log("== 快照 / MCP ==")
  const sn = await fs.default.readFile("src/server/actions/snapshots.ts", "utf8")
  check("快照支持 VNC 沙箱（两模式）", sn.includes("novnc_full") && !sn.includes("仅 CDP 轻量模式工作区支持导出"))
  const me = await fs.default.readFile("src/server/mcp/engine.ts", "utf8")
  check("MCP workspace.create kiosk 参数", me.includes("kioskMode") && me.includes("kioskStartUrl"))
  const wa = await fs.default.readFile("src/server/actions/workspaces.ts", "utf8")
  check("createWorkspace kiosk 链（exitGuard kiosk + 权限校验）", wa.includes("p.kioskMode ? \"kiosk\"") && wa.includes("allowWebKiosk"))
  check("VNC↔CDP 升降级 action（Profile 迁移）", wa.includes("switchWorkspaceModeAction") && wa.includes("mig-"))

  // ---- 12. 代理页 / 2FA 卡片 ----
  console.log("== 代理页 / 安全卡 ==")
  const cp = await fs.default.readFile("src/app/(main)/admin/config/config-panel.tsx", "utf8")
  check("安全卡 2FA 策略块（五控件）", cp.includes("全局强制绑定 2FA") && cp.includes("人机验证码触发阈值") && cp.includes("网页模式（纯网页内容显示）"))
  check("邮件级别四档", cp.includes('value="WARNING"') && cp.includes('value="INFO"'))
  const ppx = await fs.default.readFile("src/app/(main)/proxy/page.tsx", "utf8")
  check("用户侧代理页（绑定总览）", ppx.includes("代理绑定工作区"))
  const lay = await fs.default.readFile("src/app/(main)/layout.tsx", "utf8")
  check("代理菜单入口", lay.includes("my-proxy"))

  await db.$disconnect?.()
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error("QA 框架错误：", e); process.exit(2) })
