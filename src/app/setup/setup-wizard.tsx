"use client"

// ============================================================
// r38：安装向导容器 —— 两步流（数据库绑定 → 管理员创建）
// · 第一步（DatabaseBindingStep）：env 已配置可连 → 收起可跳过；
//   连不上 → 强制绑定；未配置 → 默认 SQLite 提示可高级绑定
// · 第二步（SetupForm 原有）：setup token 门 + 首个超管注册
// 已有管理员（env ADMIN_* 预置）→ 服务端直接跳过本页（见 page.tsx redirect）
// ============================================================

import { useState } from "react"
import { Database, UserPlus } from "lucide-react"
import { DatabaseBindingStep } from "./database-binding-step"
import { SetupForm } from "./setup-form"

export function SetupWizard({ tokenHint, siteName }: { tokenHint: string; siteName: string }) {
  const [step, setStep] = useState<1 | 2>(1)

  return (
    <div className="space-y-5">
      {step === 1 ? (
        <>
          <DatabaseBindingStep onDone={() => setStep(2)} />
          {/* 步骤指示 */}
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Database className="h-3.5 w-3.5" />数据库</span>
            <span>→</span>
            <span className="text-muted-foreground"><UserPlus className="inline h-3.5 w-3.5" />管理员账号</span>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg border border-teal-200 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/40 p-3 text-sm">
            <p className="font-medium text-teal-800 dark:text-teal-200">第二步 · 创建超级管理员</p>
            <p className="mt-1 text-xs leading-relaxed text-teal-700 dark:text-teal-300">
              数据库已就绪。注册第一个超级管理员后初始化通道将永久关闭；之后可随时在「账号与安全」修改。
              {siteName ? `（${siteName}）` : ""}
            </p>
          </div>
          <SetupForm tokenHint={tokenHint} />
          <button onClick={() => setStep(1)} className="w-full text-xs text-muted-underline text-muted-foreground hover:underline">
            ← 返回上一步（重新绑定数据库）
          </button>
        </>
      )}
    </div>
  )
}
