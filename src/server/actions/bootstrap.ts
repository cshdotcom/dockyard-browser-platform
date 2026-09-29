"use server"

// 首启管理员注册 Server Action（客户端仅调用此入口；服务端全量强制校验）

import { registerFirstAdmin, type FirstAdminInput } from "@/lib/bootstrap"
import type { ActionResult } from "@/lib/api"

export async function registerFirstAdminAction(input: FirstAdminInput): Promise<ActionResult<{ ok: boolean; message: string }>> {
  try {
    const res = await registerFirstAdmin(input)
    return { code: res.ok ? 0 : 40001, msg: res.message, data: { ok: res.ok, message: res.message } }
  } catch (e) {
    return { code: 50000, msg: e instanceof Error ? e.message : "注册失败" }
  }
}
