// QA 截图压缩交付（r9：VNC 企业级亮色重构 + IME + CRX 管控 + SMTP + 统一筛选 + 移动端）
import { readdir, stat, mkdir } from "fs/promises"
import { join } from "path"
import { execSync } from "child_process"

const SRC = "download/qa-r9"
const TMP = "download/qa-r9-compressed"

async function main() {
  await mkdir(TMP, { recursive: true })
  const files = (await readdir(SRC)).filter((f) => f.endsWith(".png"))
  let before = 0
  let after = 0
  for (const f of files) {
    const src = join(SRC, f)
    const dst = join(TMP, f.replace(".png", ".jpg"))
    before += (await stat(src)).size
    // 压缩：质量 72、宽度上限 1440（保留文字可读性）
    execSync(`python3 -c "
from PIL import Image
img = Image.open('${src}').convert('RGB')
if img.width > 1440:
    img = img.resize((1440, int(img.height * 1440 / img.width)), Image.LANCZOS)
img.save('${dst}', 'JPEG', quality=72, optimize=True)
"`)
    after += (await stat(dst)).size
  }
  const pct = before > 0 ? Math.round((1 - after / before) * 1000) / 10 : 0
  console.log(`压缩 ${files.length} 张：${(before / 1024 / 1024).toFixed(1)}MB → ${(after / 1024 / 1024).toFixed(2)}MB（-${pct}%）`)
  execSync(`cd ${TMP} && zip -q -9 ../qa-r9-screenshots.zip *.jpg && cd - > /dev/null`)
  console.log("打包完成：download/qa-r9-screenshots.zip")
}

main().catch((e) => { console.error(e); process.exit(1) })
