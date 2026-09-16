# Живая проверка расширения в настоящем браузере.
#
# Проходит всю цепочку: страница грузит поток → расширение его ловит → окно
# спрашивает качества → помощник качает → файл лежит на диске.
#
# Запуск:  python tests/живая-проверка.py
# Нужен установленный помощник (helper/установить.bat) и Chrome.

import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
EXT_ID = "bddbplfelcdknmmmbidbeecominenlcg"
PORT = 8899

# Публичный тестовый поток Apple — он для того и опубликован.
STREAM = (
    "https://devstreaming-cdn.apple.com/videos/streaming/examples/"
    "img_bipbop_adv_example_fmp4/master.m3u8"
)

PAGE = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Урок 2. Как читать дизайн-проекты</title>
<meta property="og:title" content="Урок 2. Как читать дизайн-проекты">
</head><body>
<h1>Тестовая страница курса</h1>
<p id="s">запрашиваю поток…</p>
<script>
// Ровно то, что делает плеер: тянет мастер-плейлист обычным fetch.
fetch("{STREAM}").then(r => r.text()).then(t => {{
  document.getElementById("s").textContent = "плейлист получен, строк: " + t.split("\\n").length;
}}).catch(e => document.getElementById("s").textContent = "ошибка: " + e);
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


failures = []


def check(name, ok, detail=""):
    print(f"{'ok   ' if ok else 'ПЛОХО'} {name}{'' if ok else '  — ' + str(detail)}")
    if not ok:
        failures.append(name)


def main():
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    out_dir = Path(tempfile.gettempdir()) / "videolov-live"
    shutil.rmtree(out_dir, ignore_errors=True)
    profile = tempfile.mkdtemp(prefix="videolov-profile-")

    with sync_playwright() as p:
        # ⚠ Не «chrome», а Chromium из поставки Playwright. Обычный Chrome с
        # 137-й версии выбросил поддержку --load-extension совсем: расширение
        # просто не загружается, список на chrome://extensions пуст, ошибок нет.
        # Проверено на Chrome 152 — ни один флаг не возвращает её обратно.
        ctx = p.chromium.launch_persistent_context(
            profile,
            headless=False,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                # Chrome с 137-й версии игнорирует --load-extension молча: флаг
                # приняли, расширение не загрузилось, ошибки нет. Возвращается
                # только этим переключателем. Проверено на Chrome 153.
                "--disable-features=DisableLoadExtensionCommandLineSwitch",
                "--no-first-run",
            ],
        )
        try:
            run(ctx, out_dir)
        finally:
            ctx.close()
            shutil.rmtree(profile, ignore_errors=True)

    server.shutdown()
    print("\nПРОВАЛОВ: " + str(len(failures)) if failures else "\nвся цепочка прошла")
    sys.exit(1 if failures else 0)


def worker(ctx):
    """Фоновый скрипт расширения. После загрузки он может ещё спать."""
    for _ in range(50):
        if ctx.service_workers:
            return ctx.service_workers[0]
        ctx.wait_for_event("serviceworker", timeout=2000)
    raise RuntimeError("фоновый скрипт так и не поднялся")


def run(ctx, out_dir):
    sw = worker(ctx)
    check("фоновый скрипт расширения поднялся", True)

    # 1. Связь с помощником — прямо из расширения, тем же путём, что и в бою.
    ping = sw.evaluate(
        """() => new Promise((resolve) => {
      const port = chrome.runtime.connectNative("ru.videolov.helper");
      const timer = setTimeout(() => resolve({error: "помощник молчит"}), 15000);
      port.onMessage.addListener((m) => { clearTimeout(timer); port.disconnect(); resolve(m); });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve({error: chrome.runtime.lastError?.message || "отключился"});
      });
      port.postMessage({t: "req", id: 1, cmd: "ping", args: {}});
    })"""
    )
    check("помощник отвечает расширению", bool(ping.get("ok")), ping.get("error"))
    if ping.get("ok"):
        d = ping["data"]
        check("помощник видит yt-dlp и ffmpeg", d["ytdlp"] and d["ffmpeg"], d)

    # 2. Страница с потоком — расширение обязано его заметить.
    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    page.wait_for_timeout(2500)
    tab_id = sw.evaluate(
        """async () => {
      const [t] = await chrome.tabs.query({url: "http://127.0.0.1:*/*"});
      return t ? t.id : null;
    }"""
    )
    check("вкладка найдена фоновым скриптом", tab_id is not None, tab_id)

    found = sw.evaluate(
        "async (id) => (await chrome.storage.session.get(`found:${id}`))[`found:${id}`] || []",
        tab_id,
    )
    check("поток замечен", len(found) > 0, f"находок: {len(found)}")
    if not found:
        return
    item = found[0]
    check("распознан как HLS", item["kind"] == "hls", item["kind"])
    check("адрес — мастер-плейлист", item["url"].endswith("master.m3u8"), item["url"])
    check(
        "имя взято из заголовка страницы",
        item["name"] == "Урок 2. Как читать дизайн-проекты",
        item["name"],
    )

    # 3. Окно расширения: страница настоящая, с ней и работаем дальше.
    popup = ctx.new_page()
    popup.set_viewport_size({"width": 400, "height": 600})
    popup.goto(f"chrome-extension://{EXT_ID}/popup.html?tab={tab_id}")
    popup.wait_for_timeout(2500)
    health = popup.inner_text(".health-text").lower()
    check("окно докладывает о помощнике", "на месте" in health, health)
    check("находка показана в окне", popup.locator(".card").count() > 0)
    check(
        "название в окне читаемое",
        "Урок 2" in popup.inner_text(".card .title"),
        popup.inner_text(".card .title"),
    )
    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    popup.screenshot(path=str(docs / "окно-список.png"))

    # Раскрываем карточку: имя, режим, качество, кнопка.
    popup.locator(".card button.ghost").first.click()
    popup.wait_for_timeout(2000)
    check("выпадашка качеств заполнилась", popup.locator(".card select").count() == 2)
    qualities = popup.locator(".card select").nth(1).inner_text()
    check("качества без повторов", qualities.count("1080p") == 1, qualities.replace("\n", " "))
    popup.screenshot(path=str(docs / "окно-выбор-качества.png"))
    print(f"      снимки окна: {docs}")
    popup.locator(".card button.ghost").first.click()  # свернуть обратно

    # Настройки: складываем в свою папку, чтобы не сорить в «Загрузках».
    popup.evaluate(
        """async (folder) => {
      await new Promise((r) => chrome.runtime.sendMessage(
        {cmd: "settings", patch: {folder, perSite: true, threads: 16, audioFormat: "m4a"}}, r));
    }""",
        str(out_dir),
    )

    # 4. Качества: быстрый путь — чтение мастер-плейлиста самим расширением.
    started = time.time()
    formats = popup.evaluate(
        """async ({tabId, itemId}) => new Promise((r) =>
      chrome.runtime.sendMessage({cmd: "probe", tabId, itemId}, r))""",
        {"tabId": tab_id, "itemId": item["id"]},
    )
    took = time.time() - started
    check("список качеств получен", bool(formats.get("ok")), formats.get("error"))
    if formats.get("ok"):
        heights = [f["height"] for f in formats["data"]["formats"]]
        check("качества разумные", 1080 in heights and len(heights) >= 3, heights)
        check("быстрый путь, без запуска процесса", formats["data"].get("fast") is True, formats["data"])
        print(f"      качества за {took:.2f} с: {heights}")

    # 5. Загрузка целиком — звук, чтобы проверка не тянулась минутами.
    res = popup.evaluate(
        """async ({tabId, itemId}) => new Promise((r) =>
      chrome.runtime.sendMessage(
        {cmd: "download", tabId, itemId, name: "Урок 2 проверка", mode: "a"}, r))""",
        {"tabId": tab_id, "itemId": item["id"]},
    )
    check("загрузка началась", bool(res.get("ok")), res.get("error"))
    if not res.get("ok"):
        return

    job_id = res["data"]["jobId"]
    deadline = time.time() + 180
    job = {}
    while time.time() < deadline:
        jobs = popup.evaluate(
            "async () => (await chrome.storage.session.get('jobs')).jobs || {}"
        )
        job = jobs.get(job_id, {})
        if job.get("status") in ("done", "error", "cancelled"):
            break
        popup.wait_for_timeout(1000)

    check("загрузка завершилась удачно", job.get("status") == "done", job)
    if job.get("status") != "done":
        return

    file = Path(job["file"])
    check("файл на диске", file.exists(), file)
    if file.exists():
        check("файл не пустой", file.stat().st_size > 100_000, file.stat().st_size)
        check("имя файла целое", file.name == "Урок 2 проверка.m4a", file.name)
        check("разложено по папке сайта", file.parent.name == "127.0.0.1", file.parent.name)

    history = popup.evaluate("async () => (await chrome.storage.local.get('history')).history || []")
    check("запись попала в историю", len(history) > 0 and history[0]["file"] == str(file), history[:1])


if __name__ == "__main__":
    main()
