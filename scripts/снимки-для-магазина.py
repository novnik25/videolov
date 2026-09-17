# Снимки для карточки в магазине: python scripts/снимки-для-магазина.py
#
# Магазин требует изображения 1280×800. Окно расширения — 400 пикселей шириной,
# поэтому его помещают на подложку с подписью, а не растягивают: растянутый
# интерфейс выглядит размытым и небрежным.

import base64
import shutil
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "магазин"

# Третье число — высота полезной части окна. Снимок делается в окне 400×600,
# и ниже содержимого остаётся пустое поле: на карточке магазина оно выглядит
# небрежно, поэтому обрезается.
SHOTS = [
    ("окно-выбор-качества.png", "Находит видео на странице", "Выбор качества, три режима сохранения", 455),
    ("окно-загрузка.png", "Загружает в несколько потоков", "Прогресс, скорость, оставшееся время", 395),
    ("окно-история.png", "Держит историю под рукой", "Открыть файл, показать в папке, удалить", 530),
]

PAGE = """
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1280px; height: 800px; overflow: hidden;
    background: radial-gradient(1200px 700px at 78%% 12%%, #1a1d3a 0%%, #0a0a0f 55%%, #050507 100%%);
    color: #ededf2;
    font: 400 16px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; gap: 72px; padding: 0 88px;
  }
  .text { flex: 1; }
  h1 {
    font-size: 46px; font-weight: 600; letter-spacing: -0.02em;
    line-height: 1.15; margin-bottom: 18px;
  }
  p { font-size: 20px; color: #8a8f9c; max-width: 30ch; }
  .brand {
    display: flex; align-items: center; gap: 12px; margin-bottom: 28px;
  }
  .brand b { font-size: 19px; font-weight: 600; }
  .brand svg { width: 30px; height: 30px; filter: drop-shadow(0 3px 10px rgba(94,106,210,.45)); }
  .shot {
    flex: none; border-radius: 18px; overflow: hidden;
    border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 4px 16px rgba(0,0,0,.4);
  }
  .shot { height: %(crop)spx; }
  .shot img { display: block; width: 400px; }
</style>
<div class="text">
  <div class="brand">
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#5E6AD2"/>
      <path d="M10 8.5l6 3.5-6 3.5z" fill="#fff"/>
    </svg>
    <b>Видеолов</b>
  </div>
  <h1>%(title)s</h1>
  <p>%(subtitle)s</p>
</div>
<div class="shot"><img src="data:image/png;base64,%(image)s"></div>
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="shots-")
    made = []

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        for name, title, subtitle, crop in SHOTS:
            src = DOCS / name
            if not src.exists():
                print(f"нет исходного снимка: {name}")
                continue
            data = base64.b64encode(src.read_bytes()).decode()
            page.set_content(
                PAGE % {"title": title, "subtitle": subtitle, "image": data, "crop": crop}
            )
            page.wait_for_timeout(400)
            dest = OUT / f"{len(made) + 1}-{name}"
            page.screenshot(path=str(dest))
            made.append(dest)
            print(f"готово: {dest.name}  1280×800")
        browser.close()

    shutil.rmtree(profile, ignore_errors=True)
    print(f"\nснимков: {len(made)} — в {OUT}")


if __name__ == "__main__":
    main()
