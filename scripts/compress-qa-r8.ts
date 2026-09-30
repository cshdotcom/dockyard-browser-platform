// r8 QA 截图压缩交付：verify/r8/*.png → download/qa-r8-screenshots.zip
import { readdirSync, statSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import sharp from "sharp"

const SRC = "/home/z/my-project/verify/r8"
const TMP = "/tmp/qa-r8-compressed"
const OUT = "/home/z/my-project/download/qa-r8-screenshots.zip"

mkdirSync(TMP, { recursive: true })
const files = readdirSync(SRC).filter(f => f.endsWith(".png"))
let rawTotal = 0
let zipTotal = 0

for (const f of files) {
  const src = join(SRC, f)
  const dst = join(TMP, f.replace(/\.png$/, ".jpg"))
  const raw = statSync(src).size
  rawTotal += raw
  // PNG 全彩截图 → JPEG q72 视觉无损（UI 截图场景体积降 60-80%）
  await sharp(src).jpeg({ quality: 72, mozjpeg: true }).toFile(dst)
  zipTotal += statSync(dst).size
}

// 用系统 zip 打包（无外部依赖）
import { execSync } from "node:child_process"
execSync(`cd ${TMP} && rm -f ${OUT} && zip -q -9 ${OUT} *.jpg`)

const finalSize = statSync(OUT).size
console.log(`压缩 ${files.length} 张：${(rawTotal / 1048576).toFixed(1)}MB → ${(finalSize / 1048576).toFixed(2)}MB（-${((1 - finalSize / rawTotal) * 100).toFixed(1)}%）`)
console.log(`交付：${OUT}`)
