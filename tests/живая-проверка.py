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
import subprocess
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
        # ⚠ По умолчанию НЕВИДИМО. Окно проверки выскакивает поверх работы
        # человека и сбивает его; показывать браузер — только по явной просьбе:
        #   VIDEOLOV_SHOW=1 python tests/живая-проверка.py
        # ⚠ channel="chromium" обязателен: в невидимом режиме Playwright по
        # умолчанию берёт УРЕЗАННУЮ сборку (chromium_headless_shell), которая
        # расширения не поддерживает вовсе — служебный скрипт не поднимается.
        ctx = p.chromium.launch_persistent_context(
            profile,
            channel="chromium",
            headless=os.environ.get("VIDEOLOV_SHOW") != "1",
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
    # ⚠ Самопроверку спрашиваем СО СТРАНИЦЫ расширения: служебный скрипт
    # собственных сообщений не получает, и из него ответ всегда пустой.
    self_check = popup.evaluate(
        """async () => new Promise((r) => chrome.runtime.sendMessage({cmd: "selfcheck"}, r))"""
    )
    sc = (self_check or {}).get("data", {}) if (self_check or {}).get("ok") else {}
    check("перехватчик подключён", sc.get("listenerOn") is True, self_check)
    check("подписка по заголовкам жива", sc.get("headersListenerOn") is True, sc.get("headersListenerOn"))
    check("запросы доходят до расширения", (sc.get("lastRequestAt") or 0) > 0, sc.get("lastRequestAt"))
    check("область хранения выбрана проверкой", bool(sc.get("storage", {}).get("probe")), sc.get("storage"))
    print(f"      хранилище: {sc.get('storage', {}).get('probe')}")

    health = popup.inner_text(".health-text").lower()
    check("окно докладывает о помощнике", "на месте" in health, health)
    # Свежая начинка не должна показывать плашку «расширение устарело».
    check("плашки об устаревшей начинке нет", "старой начинке" not in popup.inner_text("body"),
          popup.inner_text("#alert") if popup.locator("#alert").count() else "")
    check("сборка известна самопроверке", bool(sc.get("build")), sc.get("build"))
    check("находка показана в окне", popup.locator(".card").count() > 0)
    # ⚠ Заслон: пустое состояние с display:flex перебивало атрибут hidden и
    # показывалось вместе с найденным. Поймано глазами на снимке 16.09.2026.
    check("пустое состояние спрятано", popup.locator("#empty").is_hidden())
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
    check("выпадашка качеств заполнилась", popup.locator(".card select").count() == 1)
    qualities = popup.locator(".card select").first.inner_text()
    check("качества без повторов", qualities.count("1080p") == 1, qualities.replace("\n", " "))
    popup.screenshot(path=str(docs / "окно-выбор-качества.png"))
    check("режимы показаны все три", popup.locator(".seg button").count() == 3)
    check(
        "выбран режим «видео со звуком»",
        popup.locator('.seg button[aria-pressed="true"]').inner_text() == "Видео",
        popup.locator('.seg button[aria-pressed="true"]').inner_text(),
    )
    check("значки нарисованы, а не написаны", popup.locator(".card button.ghost svg").count() >= 2)

    # Правка имени не должна слетать от перерисовки состояния.
    name_input = popup.locator("input[data-name-for]")
    name_input.click()
    name_input.fill("Урок 2 переименованный")
    popup.evaluate("() => chrome.runtime.sendMessage({cmd: 'state-changed'})")
    popup.wait_for_timeout(700)
    check(
        "набранное имя пережило перерисовку",
        popup.locator("input[data-name-for]").input_value() == "Урок 2 переименованный",
        popup.locator("input[data-name-for]").input_value(),
    )
    name_input.fill("")
    popup.locator(".card button.ghost").first.click()  # свернуть обратно

    # Страница настроек — то же оформление, свои органы управления.
    opts = ctx.new_page()
    opts.set_viewport_size({"width": 760, "height": 720})
    opts.goto(f"chrome-extension://{EXT_ID}/options.html")
    opts.wait_for_timeout(2500)
    check("настройки открылись", opts.locator(".card").count() == 4)
    check("помощник виден и в настройках", "yt-dlp" in opts.inner_text("#health"), opts.inner_text("#health"))
    # Настройки обязаны показывать то, что лежит в хранилище: разойдясь,
    # страница обещает одно, а загрузка делает другое.
    check("формат звука совпадает с сохранённым", opts.locator("#audioFormat").input_value() == "m4a",
          opts.locator("#audioFormat").input_value())
    check("число потоков совпадает", opts.locator("#threads").input_value() == "16",
          opts.locator("#threads").input_value())
    check("папки сайта включены", opts.locator("#perSite").is_checked())
    check("ползунок закрашен по значению",
          opts.evaluate("() => document.querySelector('#threads').style.getPropertyValue('--fill')") != "",
          "--fill пуст")
    opts.screenshot(path=str(docs / "настройки.png"), full_page=True)
    opts.close()
    print(f"      снимки окна: {docs}")

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

    # Снимок на ходу: полоса, скорость, остаток.
    popup.wait_for_timeout(4000)
    check("раздел «Качается» появился", popup.locator("#jobs-section").is_visible())
    check("полоса прогресса рисуется", popup.locator("#jobs .progress i").count() == 1)
    popup.screenshot(path=str(ROOT / "docs" / "окно-загрузка.png"))

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

    popup.wait_for_timeout(1200)
    check("история показана в окне", popup.locator("#history .card").count() > 0)
    check_cancel(popup, tab_id, item)
    check("кнопки истории со значками", popup.locator("#history .card button svg").count() >= 3)
    popup.screenshot(path=str(ROOT / "docs" / "окно-история.png"))


def running_ytdlp():
    """Сколько процессов yt-dlp живо прямо сейчас."""
    out = subprocess.run(
        ["tasklist", "/fi", "imagename eq yt-dlp.exe", "/nh"],
        capture_output=True, text=True, encoding="cp866", errors="replace",
    ).stdout
    return out.lower().count("yt-dlp.exe")


def check_cancel(popup, tab_id, item):
    """Отмена обязана убить и yt-dlp, и запущенный им ffmpeg."""
    res = popup.evaluate(
        """async ({tabId, itemId}) => new Promise((r) =>
      chrome.runtime.sendMessage(
        {tabId, itemId, cmd: "download", name: "Отменяемая", mode: "av", height: 1080}, r))""",
        {"tabId": tab_id, "itemId": item["id"]},
    )
    if not res.get("ok"):
        check("вторая загрузка началась", False, res.get("error"))
        return
    job_id = res["data"]["jobId"]
    popup.wait_for_timeout(4000)
    check("процесс загрузки запущен", running_ytdlp() > 0, "yt-dlp не найден в списке процессов")

    popup.evaluate(
        """async (jobId) => new Promise((r) =>
      chrome.runtime.sendMessage({cmd: "cancel", jobId}, r))""",
        job_id,
    )
    popup.wait_for_timeout(2500)
    jobs = popup.evaluate("async () => (await chrome.storage.session.get('jobs')).jobs || {}")
    check("загрузка помечена отменённой", jobs.get(job_id, {}).get("status") == "cancelled",
          jobs.get(job_id))
    check("процесс убит, а не брошен", running_ytdlp() == 0,
          f"живых yt-dlp: {running_ytdlp()}")


if __name__ == "__main__":
    main()
