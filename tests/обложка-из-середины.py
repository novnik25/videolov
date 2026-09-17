# Обложка обязана быть кадром ИЗ СЕРЕДИНЫ ролика — и это проверяется цветом.
#
# Образец в tests/образец: 30 секунд, первые десять красные, вторые зелёные,
# последние синие. Середина — 15-я секунда, то есть зелёная. Если на обложке
# зелёный, кадр взят из середины; красный — взят с начала; синего быть не может.
#
# Раздаётся всё это так же, как на GetCourse: плейлисты без расширения .m3u8 и
# с типом application/json, куски под именем N.bin в /api/storage/chunk/.
#
# Запуск: python tests/обложка-из-середины.py

import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
SAMPLE = Path(__file__).resolve().parent / "образец"
EXT_ID = "bddbplfelcdknmmmbidbeecominenlcg"
PORT = 8905

H1 = "0b95479e669505fb09075d70da9ec3a0"
H2 = "eaa19b6afc39a28d9d35814a4f19631b"

SEGMENTS = sorted(SAMPLE.glob("seg*.ts"), key=lambda p: int(p.stem[3:]))

MASTER_BODY = f"""#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=320x180
/api/playlist/media/{H1}/{H2}/180?consumer=vod
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
/api/playlist/media/{H1}/{H2}/720?consumer=vod
"""

MEDIA_BODY = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-PLAYLIST-TYPE:VOD\n" + "".join(
    f"#EXTINF:5.000,\n/api/storage/chunk/{H1}/{H2}/180/{i}.bin?host=vh-125\n"
    for i in range(len(SEGMENTS))
) + "#EXT-X-ENDLIST\n"

PAGE = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Урок 9. Как считать смету</title>
<meta property="og:title" content="Урок 9. Как считать смету">
<meta property="og:image" content="http://127.0.0.1:{PORT}/covers/module3.png">
</head><body><h1>Урок</h1><p id="s">…</p>
<script>
(async () => {{
  await fetch("/api/playlist/master/{H1}/{H2}?jwt=eyJ0eXAiOiJKV1Qi");
  await fetch("/api/playlist/media/{H1}/{H2}/180?consumer=vod");
  await fetch("/api/storage/chunk/{H1}/{H2}/180/0.bin?host=vh-125");
  document.getElementById("s").textContent = "плеер отработал";
}})();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path
        if path == "/":
            return self.send(PAGE.encode("utf-8"), "text/html; charset=utf-8")
        if path.startswith("/api/playlist/master/"):
            return self.send(MASTER_BODY.encode("utf-8"), "application/json")
        if path.startswith("/api/playlist/media/"):
            return self.send(MEDIA_BODY.encode("utf-8"), "application/json")
        if path.startswith("/api/storage/chunk/"):
            n = int(path.split("/")[-1].split(".")[0])
            data = SEGMENTS[n % len(SEGMENTS)].read_bytes()
            return self.send(data, "application/octet-stream")
        return self.send(b"{}", "application/json")

    def send(self, data, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


failures = []


def check(name, ok, detail=""):
    print(f"{'ok   ' if ok else 'ПЛОХО'} {name}{'' if ok else '  — ' + str(detail)}")
    if not ok:
        failures.append(name)


def main():
    if not SEGMENTS:
        print("нет образца в tests/образец — запусти подготовку образца")
        sys.exit(1)

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="videolov-poster-")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile,
            channel="chromium",
            headless=os.environ.get("VIDEOLOV_SHOW") != "1",
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--disable-features=DisableLoadExtensionCommandLineSwitch",
                "--no-first-run",
            ],
        )
        try:
            run(ctx)
        finally:
            ctx.close()
            shutil.rmtree(profile, ignore_errors=True)

    server.shutdown()
    print("\nПРОВАЛОВ: " + str(len(failures)) if failures else "\nвсё сошлось")
    sys.exit(1 if failures else 0)


def run(ctx):
    for _ in range(50):
        if ctx.service_workers:
            break
        ctx.wait_for_event("serviceworker", timeout=2000)
    sw = ctx.service_workers[0]
    for _ in range(40):
        if sw.evaluate("() => chrome.webRequest.onBeforeRequest.hasListeners()"):
            break
        sw.evaluate("() => new Promise((r) => setTimeout(r, 250))")

    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    tab_id = sw.evaluate(
        "async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id"
    )

    found = []
    for _ in range(40):
        found = sw.evaluate(
            "async (id) => (await chrome.storage.session.get(`found:${id}`))[`found:${id}`] || []",
            tab_id,
        )
        if found:
            break
        page.wait_for_timeout(500)
    check("урок найден", len(found) == 1, f"находок: {len(found)}")
    if not found:
        return

    popup = ctx.new_page()
    popup.set_viewport_size({"width": 400, "height": 600})
    popup.goto(f"chrome-extension://{EXT_ID}/popup.html?tab={tab_id}")

    # Кадр режется ffmpeg'ом — ждём его появления, а не отмеренных секунд.
    src = ""
    for _ in range(60):
        src = popup.evaluate(
            "() => document.querySelector('#found .thumb img')?.src || ''"
        )
        if src:
            break
        popup.wait_for_timeout(1000)

    check("обложка появилась", bool(src), "картинки в карточке нет")
    if not src:
        state = popup.evaluate(
            """async () => new Promise((r) =>
          chrome.runtime.sendMessage({cmd: "preview", tabId: %d, itemId: %s}, r))"""
            % (tab_id, repr(found[0]["id"]).replace("'", '"'))
        )
        print("      ответ на заказ кадра:", state)
        return

    check("это картинка, а не ссылка на страницу", src.startswith("data:image/jpeg"), src[:40])

    # Главное: цвет кадра. Зелёный — середина, красный — начало.
    colour = popup.evaluate(
        """async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return {r: d[0], g: d[1], b: d[2], w: c.width, h: c.height};
    }""",
        src,
    )
    print(f"      цвет середины кадра: {colour}")
    check("кадр из СЕРЕДИНЫ ролика (зелёный)", colour["g"] > colour["r"] + 40 and colour["g"] > colour["b"] + 40, colour)
    check("кадр не с начала (не красный)", colour["r"] < colour["g"], colour)
    check("размер кадра разумный", colour["w"] >= 200, colour)

    popup.screenshot(path=str(ROOT / "docs" / "окно-обложка-курса.png"))


if __name__ == "__main__":
    main()
