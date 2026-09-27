import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions, revokeLoginSession } from "@/lib/auth"
import { db } from "@/lib/db"
import { writeSecurityEvent, writeAudit } from "@/lib/audit"

// 登出：撤销当前登录会话 + RefreshToken黑名单 + NextAuth signOut 由前端调用
export async function POST() {
  const session = await getServerSession(authOptions)
  const sid = (session?.user as Record<string, unknown> | undefined)?.loginSessionId as string | undefined
  if (sid) {
    await revokeLoginSession(sid, "LOGOUT")
    const uid = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined
    const uname = session?.user?.name
    await writeSecurityEvent({ userId: uid, username: uname, eventType: "LOGOUT", detail: "用户主动登出" })
    await writeAudit({ operatorUserId: uid, operatorName: uname, operationType: "LOGOUT", resourceType: "USER", resourceId: uid, resourceName: uname })
  }
  return NextResponse.json({ code: 0, msg: "ok" })
}
