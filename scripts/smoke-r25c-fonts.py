#!/usr/bin/env python3
# ============================================================
# r25-c 多语言渲染冒烟测试
# 1) 从 Dockerfile 提取 printf 生成的 fontconfig local.conf → XML 合法性校验
# 2) Dockerfile 字体/locale 包清单断言（fonts-noto-core / color-emoji / unifont / 34 locale）
# 3) 本地 chromium headless 真实渲染 24 种语言样本 → 逐行墨水像素统计（渲染管线端到端）
#    + fc-list :lang=xx 覆盖断言（Chromium 选字体的权威机制 = fontconfig lang 匹配）
# ============================================================
import re, subprocess, sys, os, tempfile

DOCKERFILE = "/home/z/my-project/Dockerfile"
CHROME = os.path.expanduser("~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")
OUT_PNG = "/home/z/my-project/download/qa-r25/fonts-multilang.png"

passed, failed = [], []
def ok(name): passed.append(name); print(f"  ✓ {name}")
def bad(name, why=""): failed.append(name); print(f"  ✗ {name} {why}")

src = open(DOCKERFILE, encoding="utf-8").read()

# ---- 1) local.conf XML 校验 ----
m = re.search(r"printf '%s\\n' (.*?)> /etc/fonts/local\.conf", src, re.S)
assert m, "Dockerfile 中未找到 local.conf printf 块"
lines = re.findall(r"'([^']*)'", m.group(1))
xml = "\n".join(lines)
import xml.etree.ElementTree as ET
try:
    ET.fromstring(xml)
    ok(f"local.conf XML 可解析（{len(lines)} 行，{xml.count('<family>')} 个 family 引用）")
except ET.ParseError as e:
    bad("local.conf XML 解析", str(e))

for fam in ["Liberation Sans", "Noto Sans CJK SC", "Noto Color Emoji", "Unifont", "Noto Sans Arabic", "Noto Sans Thai", "Noto Sans Devanagari"]:
    if f"<family>{fam}</family>" in xml: ok(f"回退链含 {fam}")
    else: bad(f"回退链缺 {fam}")

# ---- 2) Dockerfile 包清单断言 ----
for pkg in ["fonts-noto-cjk", "fonts-noto-core", "fonts-noto-mono", "fonts-noto-extra",
            "fonts-noto-color-emoji", "fonts-unifont", "fontconfig"]:
    if pkg in src: ok(f"主镜像含 {pkg}")
    else: bad(f"主镜像缺 {pkg}")

locm = re.search(r"for loc in (.*?); do", src, re.S)
locales = locm.group(1).replace("\\\n", " ").split() if locm else []
if len(locales) >= 30: ok(f"locale 清单 {len(locales)} 个（≥30）")
else: bad("locale 清单", f"仅 {len(locales)} 个")

bsrc = open("/home/z/my-project/docker/browser/Dockerfile", encoding="utf-8").read()
for pkg in ["fonts-noto-core", "fonts-noto-color-emoji", "fonts-unifont"]:
    if pkg in bsrc: ok(f"browser 镜像含 {pkg}")
    else: bad(f"browser 镜像缺 {pkg}")

# ---- 3) 真实渲染测试 ----
SAMPLES = [
    ("zh-CN", "简体中文渲染测试：浏览器沙箱平台全局搜索"),
    ("zh-TW", "繁體中文渲染測試：瀏覽器沙箱平台全域搜尋"),
    ("en",    "English rendering test: sandbox browser platform works"),
    ("ja",    "日本語のレンダリングテスト：ブラウザサンドボックス"),
    ("ko",    "한국어 렌더링 테스트: 브라우저 샌드박스 플랫폼"),
    ("ru",    "Русский тест рендеринга: платформа песочницы браузера"),
    ("uk",    "Український тест рендерингу: платформа браузерної пісочниці"),
    ("de",    "Deutscher Rendering-Test: Browser-Sandbox-Plattform"),
    ("fr",    "Test de rendu français : plateforme navigateur sandbox"),
    ("es",    "Prueba de renderizado en español: plataforma de navegador"),
    ("pt",    "Teste de renderização em português: plataforma de navegador"),
    ("it",    "Test di rendering italiano: piattaforma browser sandbox"),
    ("nl",    "Nederlandse rendertest: browsersandbox-platform"),
    ("pl",    "Polski test renderowania: platforma piaskownicy przeglądarki"),
    ("cs",    "Český test vykreslování: platforma prohlížečové sandboxu"),
    ("el",    "Ελληνική δοκιμή απόδοσης: πλατφόρμα sandbox προγράμματος"),
    ("tr",    "Türkçe işleme testi: tarayıcı korumalı alan platformu"),
    ("ar",    "اختبار العرض بالعربية: منصة صندوق الحماية للمتصفح"),
    ("he",    "בדיקת עיבוד בעברית: פלטפורמת ארגז חול לדפדפן"),
    ("fa",    "آزمایش نمایش فارسی: سکوی امن مرورگر"),
    ("hi",    "हिन्दी रेंडरिंग परीक्षण: ब्राउज़र सैंडबॉक्स प्लेटफ़ॉर्म"),
    ("th",    "การทดสอบการแสดงผลภาษาไทย: แพลตฟอร์มแซนด์บ็อกซ์เบราว์เซอร์"),
    ("vi",    "Kiểm tra hiển thị tiếng Việt: nền tảng trình duyệt sandbox"),
    ("id",    "Uji rendering bahasa Indonesia: platform peramban sandbox"),
]
ROW_H = 34
html = ["<html><head><meta charset='utf-8'><style>body{margin:0;font-family:sans-serif;font-size:18px;background:#fff}",
        f".r{{height:{ROW_H}px;padding:2px 8px;display:flex;align-items:center;white-space:nowrap}}",
        ".t{{color:#999;font-size:12px;margin-right:10px;min-width:64px}}</style></head><body>"]
for code, text in SAMPLES:
    html.append(f"<div class='r' id='{code}'><span class='t'>{code}</span><span>{text}</span></div>")
html.append("</body></html>")

with tempfile.TemporaryDirectory() as td:
    hpath = os.path.join(td, "ml.html")
    open(hpath, "w", encoding="utf-8").write("\n".join(html))
    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    r = subprocess.run([CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                        f"--screenshot={OUT_PNG}", "--window-size=1000," + str(ROW_H * len(SAMPLES) + 8),
                        "file://" + hpath], capture_output=True, timeout=60)
    if r.returncode != 0 or not os.path.exists(OUT_PNG):
        bad("chromium headless 截图失败", r.stderr.decode()[:200])
        sys.exit(1)
    ok(f"chromium 渲染截图生成（{len(SAMPLES)} 语言 × 34px 行）")

    from PIL import Image
    img = Image.open(OUT_PNG).convert("L")
    px = img.load()
    W, H = img.size
    # 每行墨水像素（跳过左侧 80px 语言标签区，避免标签计入样本墨水）
    # 全行高扫描 + 阈值 200（容忍细笔画抗锯齿；本地回退字体的基线可能贴近行底，窄窗会漏计）
    for i, (code, text) in enumerate(SAMPLES):
        y0, y1 = i * ROW_H, (i + 1) * ROW_H
        ink = 0
        xs = []
        for y in range(y0 + 1, min(y1 - 1, H)):
            for x in range(80, W):
                if px[x, y] < 200:
                    ink += 1
                    xs.append(x)
        span = (max(xs) - min(xs)) if xs else 0
        # 18px 字号 10+ 字符 → 宽度应 ≥ 150px 且墨水 ≥ 100px；空白=未渲染
        if ink > 100 and span > 150:
            # fc-list 覆盖（Chromium 选字体的机制）：
            fl = subprocess.run(["fc-list", f":lang={code}"], capture_output=True, text=True)
            n = len(fl.stdout.strip().splitlines()) if fl.stdout.strip() else 0
            if n > 0: ok(f"{code} 渲染墨水 {ink}px · 宽 {span}px · fontconfig 覆盖 {n} 字体")
            else: bad(f"{code} fontconfig 零覆盖（本地环境）；Docker 镜像由 noto-core 覆盖")
        else:
            bad(f"{code} 渲染墨水不足（{ink}px · 宽 {span}px）")

print(f"\n=== r25-c 字体冒烟：{len(passed)} 通过 / {len(failed)} 失败 ===")
sys.exit(1 if failed else 0)
