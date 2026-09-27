// @novnc/novnc 无类型声明 —— 最小化类型契约（运行时以动态 import 加载）
declare module "@novnc/novnc" {
  export interface RFBEventDetail {
    detail?: {
      text?: string
      reason?: string
      code?: number
      hasCredential?: boolean
    }
  }
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: Record<string, unknown>)
    connect(): void
    disconnect(): void
    sendCredentials(creds: { password?: string; username?: string }): void
    sendCtrlAltDel(): void
    sendKeys(keys: number[]): void
    focus(): void
    blur(): void
    clipboardPasteFromLocal(text: string): void
    get capabilities(): { power: boolean; clipboard: boolean }
    get viewOnly(): boolean
    set viewOnly(v: boolean)
    get scaleViewport(): boolean
    set scaleViewport(v: boolean)
    set resizeSession(v: boolean)
    set showDotCursor(v: boolean)
    set qualityLevel(v: number)
    set compressLevel(v: number)
    addEventListener(type: string, listener: (e: RFBEventDetail & Event) => void): void
    removeEventListener(type: string, listener: (e: RFBEventDetail & Event) => void): void
  }
}
