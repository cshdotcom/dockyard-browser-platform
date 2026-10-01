// r11 QA 截图压缩（PNG → JPEG 质量压缩，与既往轮次同策略）
import { readdir, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import sharp from "sharp"

const SRC = "/home/z/my-project/verify/r11"
const DST = "/home/z/my-project/verify/r11-compressed"

async function main() {
  await mkdir(DST, { recursive: true })
  const files = (await readdir(SRC)).filter((f) => f.endsWith(".png"))
  let srcBytes = 0
  let dstBytes = 0
  for (const f of files) {
    const input = await readFile(join(SRC, f))
    srcBytes += input.length
    const out = await sharp(input).jpeg({ quality: 72, mozjpeg: true }).toBuffer()
    dstBytes += out.length
    await writeFile(join(DST, f.replace(".png", ".jpg")), out)
    console.log(`${f} -> ${(input.length / 1024).toFixed(0)}KB -> ${(out.length / 1024).toFixed(0)}KB`)
  }
  console.log(`\n共 ${files.length} 张：${(srcBytes / 1024 / 1024).toFixed(2)}MB -> ${(dstBytes / 1024 / 1024).toFixed(2)}MB（-${(((srcBytes - dstBytes) / srcBytes) * 100).toFixed(1)}%）`)
}
main().catch((e) => { console.error(e); process.exit(1) })
