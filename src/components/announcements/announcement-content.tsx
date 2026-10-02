"use client"

// ============================================================
// 公告内容渲染器：Markdown + 直接 HTML 双支持
//   · 内容含 HTML 块级标签 → rehype-raw 解析原始 HTML + rehype-sanitize 白名单消毒
//   · 其余 → react-markdown 标准渲染（表格/代码块/引用/任务列表/链接…）
//   · 两侧统一 Tailwind 样式映射（无 typography 依赖，组件级样式自包含）
//   · sanitize 白名单：块级/行内/表格/媒体标签；禁 script/iframe/object/embed/
//     form/input/base/meta/link；剥离 on* 事件属性与 javascript: 协议
// ============================================================

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"

// HTML 块级标签探测（内容任意位置出现即启用 raw 渲染）
const HTML_TAG_RE = /<(?:div|span|p|section|article|header|footer|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|img|a|br|hr|strong|em|b|i|u|s|blockquote|pre|code|details|summary|figure|figcaption|center|font|video|audio|source)\b[^>]*>/i

export function looksLikeHtml(content: string): boolean {
  return HTML_TAG_RE.test(content)
}

// sanitize 白名单（在默认 schema 上扩展公告常用标签与样式类）
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "video", "audio", "source", "figure", "figcaption", "center", "font", "details", "summary", "s", "u", "img",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] || []), "className", "style", "align", "width", "height", "target"],
    a: [...(defaultSchema.attributes?.a || []), "target", "rel"],
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title", "width", "height", "loading"],
    video: ["src", "controls", "width", "height", "poster", "muted", "loop"],
    audio: ["src", "controls", "loop"],
    source: ["src", "type"],
    font: ["color", "size", "face"],
    td: ["colspan", "rowspan", "align"],
    th: ["colspan", "rowspan", "align"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href || []), "http", "https", "mailto", "tel"],
    src: [...(defaultSchema.protocols?.src || []), "http", "https", "data"],
  },
}

// 跑马灯/站内信摘要用：剥离 MD 语法与 HTML 标签 → 纯文本
export function contentToPlainText(content: string, maxLen = 120): string {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>|#-]+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
}

const MD_STYLES: Record<string, string> = {
  h1: "text-xl font-bold mt-4 mb-2 first:mt-0",
  h2: "text-lg font-bold mt-4 mb-2 first:mt-0",
  h3: "text-base font-semibold mt-3 mb-1.5 first:mt-0",
  h4: "text-sm font-semibold mt-3 mb-1 first:mt-0",
  p: "text-sm leading-relaxed my-2",
  a: "text-teal-600 dark:text-teal-400 underline underline-offset-2 hover:opacity-80",
  ul: "list-disc pl-5 my-2 space-y-1",
  ol: "list-decimal pl-5 my-2 space-y-1",
  li: "text-sm leading-relaxed",
  blockquote: "border-l-4 border-teal-300 dark:border-teal-700 bg-muted/60 pl-3 pr-2 py-1.5 my-2 rounded-r text-sm text-muted-foreground",
  code: "bg-muted rounded px-1.5 py-0.5 text-[13px] font-mono text-teal-700 dark:text-teal-300",
  pre: "bg-muted rounded-md p-3 my-2 overflow-x-auto text-[13px] leading-relaxed",
  table: "my-2 w-full border-collapse text-sm",
  th: "border px-2 py-1.5 bg-muted font-semibold text-left",
  td: "border px-2 py-1.5 align-top",
  tr: "border-b",
  hr: "my-3 border-border",
  img: "max-w-full rounded-md my-2",
  strong: "font-bold",
  em: "italic",
  del: "line-through text-muted-foreground",
  input: "mr-1.5 accent-teal-600",
}

const MD_COMPONENTS = {
  h1: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h1 {...p} className={`${MD_STYLES.h1} ${p.className || ""}`} />,
  h2: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h2 {...p} className={`${MD_STYLES.h2} ${p.className || ""}`} />,
  h3: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h3 {...p} className={`${MD_STYLES.h3} ${p.className || ""}`} />,
  h4: (p: React.HTMLAttributes<HTMLHeadingElement>) => <h4 {...p} className={`${MD_STYLES.h4} ${p.className || ""}`} />,
  p: (p: React.HTMLAttributes<HTMLParagraphElement>) => <p {...p} className={`${MD_STYLES.p} ${p.className || ""}`} />,
  a: (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...p} className={`${MD_STYLES.a} ${p.className || ""}`} target={p.target || "_blank"} rel="noopener noreferrer" />
  ),
  ul: (p: React.HTMLAttributes<HTMLUListElement>) => <ul {...p} className={`${MD_STYLES.ul} ${p.className || ""}`} />,
  ol: (p: React.HTMLAttributes<HTMLOListElement>) => <ol {...p} className={`${MD_STYLES.ol} ${p.className || ""}`} />,
  li: (p: React.HTMLAttributes<HTMLLIElement>) => <li {...p} className={`${MD_STYLES.li} ${p.className || ""}`} />,
  blockquote: (p: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote {...p} className={`${MD_STYLES.blockquote} ${p.className || ""}`} />
  ),
  code: (p: React.HTMLAttributes<HTMLElement>) => <code {...p} className={`${MD_STYLES.code} ${p.className || ""}`} />,
  pre: (p: React.HTMLAttributes<HTMLPreElement>) => <pre {...p} className={`${MD_STYLES.pre} ${p.className || ""}`} />,
  table: (p: React.HTMLAttributes<HTMLTableElement>) => <table {...p} className={`${MD_STYLES.table} ${p.className || ""}`} />,
  th: (p: React.HTMLAttributes<HTMLTableCellElement>) => <th {...p} className={`${MD_STYLES.th} ${p.className || ""}`} />,
  td: (p: React.HTMLAttributes<HTMLTableCellElement>) => <td {...p} className={`${MD_STYLES.td} ${p.className || ""}`} />,
  hr: (p: React.HTMLAttributes<HTMLHRElement>) => <hr {...p} className={`${MD_STYLES.hr} ${p.className || ""}`} />,
  img: (p: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...p} alt={p.alt || ""} className={`${MD_STYLES.img} ${p.className || ""}`} loading="lazy" />,
  strong: (p: React.HTMLAttributes<HTMLElement>) => <strong {...p} className={`${MD_STYLES.strong} ${p.className || ""}`} />,
  em: (p: React.HTMLAttributes<HTMLElement>) => <em {...p} className={`${MD_STYLES.em} ${p.className || ""}`} />,
  del: (p: React.HTMLAttributes<HTMLElement>) => <del {...p} className={`${MD_STYLES.del} ${p.className || ""}`} />,
  input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${MD_STYLES.input} ${p.className || ""}`} />,
}

// 内容容器（换行保留 + 断词），表格容器横向滚动（移动端不溢出）
export function AnnouncementContent({ content, className }: { content: string; className?: string }) {
  const html = looksLikeHtml(content)
  return (
    <div className={`announcement-content ${className || ""}`}>
      <div className="overflow-x-auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={html ? [[rehypeRaw, { passThrough: ["element"] }], [rehypeSanitize, SANITIZE_SCHEMA]] : []}
          components={MD_COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  )
}

// 单行纯文本形态（跑马灯/列表摘要/通知铃）
export function AnnouncementSummary({ content, maxLen = 120, className }: { content: string; maxLen?: number; className?: string }) {
  return <span className={className}>{contentToPlainText(content, maxLen)}</span>
}
