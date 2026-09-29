// QA 截图压缩打包：verify/r7/*.png → download/qa-r7/（调色板量化 + 1280 宽）→ zip
import sharp from "sharp"
import { readdir, mkdir, copyFile } from "node:fs/promises"
import { execSync } from "node:child_process"

const SRC = "/home/z/my-project/verify/r7"
const DST = "/home/z/my-project/download/qa-r7"

async function main() {
  await mkdir(DST, { recursive: true })
  const files = (await readdir(SRC)).filter((f) => f.endsWith(".png"))
  let totalBefore = 0
  let totalAfter = 0
  for (const f of files) {
    const inPath = `${SRC}/${f}`
    const outPath = `${DST}/${f}`
    const before = Number(execSync(`stat -c%s "${inPath}"`).toString().trim())
    await sharp(inPath)
      .resize({ width: 1280, withoutEnlargement: true })
      .png({ quality: 80, palette: true, compressionLevel: 9, effort: 9 })
      .toFile(outPath)
    const after = Number(execSync(`stat -c%s "${outPath}"`).toString().trim())
    totalBefore += before
    totalAfter += after
  }
  const pct = ((1 - totalAfter / totalBefore) * 100).toFixed(1)
  console.log(`压缩完成：${files.length} 张，${(totalBefore / 1048576).toFixed(1)}MB → ${(totalAfter / 1048576).toFixed(1)}MB（-${pct}%）`)

  execSync(`cd /home/z/my-project/download && rm -f qa-r7-screenshots.zip && zip -q -9 -r qa-r7-screenshots.zip qa-r6/`)
  const zipSize = Number(execSync(`stat -c%s /home/z/my-project/download/qa-r7-screenshots.zip`).toString().trim())
  console.log(`ZIP 包：qa-r7-screenshots.zip ${(zipSize / 1048576).toFixed(1)}MB（${files.length} 张）`)
}

main().catch((e) => { console.error(e); process.exit(1) })
