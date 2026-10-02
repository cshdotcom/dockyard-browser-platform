#!/usr/bin/env python3
"""QA 截图压缩打包：PNG → JPEG(quality 72, max-width 1280) → zip"""
import os
import sys
import zipfile
from PIL import Image

SRC = "/home/z/my-project/qa/r13"
TMP = "/tmp/qa-r13-jpg"
OUT = "/home/z/my-project/download/qa-r13-screenshots.zip"

os.makedirs(TMP, exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

files = sorted(f for f in os.listdir(SRC) if f.endswith(".png"))
total_src = total_dst = 0
for f in files:
    src_path = os.path.join(SRC, f)
    dst_path = os.path.join(TMP, f.replace(".png", ".jpg"))
    img = Image.open(src_path).convert("RGB")
    if img.width > 1280:
        nh = int(img.height * 1280 / img.width)
        img = img.resize((1280, nh), Image.LANCZOS)
    img.save(dst_path, "JPEG", quality=72, optimize=True)
    total_src += os.path.getsize(src_path)
    total_dst += os.path.getsize(dst_path)

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for f in sorted(os.listdir(TMP)):
        if f.endswith(".jpg"):
            zf.write(os.path.join(TMP, f), f)

print(f"{len(files)} 张 | PNG {total_src/1024/1024:.1f}MB → JPEG {total_dst/1024/1024:.1f}MB (压缩 {100 - total_dst*100//total_src}%)")
print(f"zip: {OUT} {os.path.getsize(OUT)/1024:.0f}KB")
