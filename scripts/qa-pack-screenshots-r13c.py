#!/usr/bin/env python3
# r13c：QA 截图压缩打包（JPEG q72 / 1280px）→ download/qa-r13c-screenshots.zip
import glob, os, zipfile
from PIL import Image

SRC = "qa/r13c"
OUT_DIR = "download"
ZIP = os.path.join(OUT_DIR, "qa-r13c-screenshots.zip")
os.makedirs(OUT_DIR, exist_ok=True)

files = sorted(glob.glob(os.path.join(SRC, "*.png")))
if not files:
    print("无截图可打包")
    raise SystemExit(1)

with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as zf:
    for f in files:
        im = Image.open(f).convert("RGB")
        w, h = im.size
        if w > 1280:
            im = im.resize((1280, int(h * 1280 / w)), Image.LANCZOS)
        tmp = "/tmp/qa-r13c-" + os.path.basename(f).replace(".png", ".jpg")
        im.save(tmp, "JPEG", quality=72, optimize=True)
        zf.write(tmp, os.path.basename(tmp))
        os.remove(tmp)

print(f"打包完成：{ZIP}（{len(files)} 张，{os.path.getsize(ZIP)//1024} KB）")
