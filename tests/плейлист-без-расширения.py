# Воспроизведение живого случая: площадка на движке GetCourse.
#
# Там нет ни одной приметы, на которые обычно ловят видео:
#   • плейлист лежит по адресу /api/playlist/master/<хеш>/<хеш>?jwt=… — без .m3u8;
#   • отдаётся с типом application/json, а не с mpegurl;
#   • куски называются 34.bin и лежат в /api/storage/chunk/.
# Расширение обязано узнать плейлист ПО СОДЕРЖИМОМУ и показать ОДНУ строку —
# мастер, а не мастер плюс каждое качество.
#
# Запуск: python tests/плейлист-без-расширения.py

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
EXT_ID = "bddbplfelcdknmmmbidbeecominenlcg"
PORT = 8903

H1 = "0b95479e669505fb09075d70da9ec3a0"
H2 = "eaa19b6afc39a28d9d35814a4f19631b"
B1 = "1c84e2ff77a616ac1a186e81eb0fd4b1"
B2 = "fb5b28a7cd4ab39ea46925b5c8742a2c"
MASTER = f"/api/playlist/master/{H1}/{H2}?user-cdn=cdnvideo&jwt=eyJ0eXAiOiJKV1Qi"
MEDIA = f"/api/playlist/media/{H1}/{H2}/480?consumer=vod&sid="

MASTER_BODY = f"""#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
/api/playlist/media/{H1}/{H2}/480?consumer=vod&sid=
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
/api/playlist/media/{H1}/{H2}/720?consumer=vod&sid=
"""

MEDIA_BODY = f"""#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
/api/storage/chunk/{H1}/{H2}/480/0.bin?host=vh-125
#EXTINF:10.0,
/api/storage/chunk/{H1}/{H2}/480/1.bin?host=vh-125
#EXT-X-ENDLIST
"""

# Страница ведёт себя как плеер GetCourse: тянет мастер, затем качество,
# затем куски — и попутно долбит служебные запросы, как настоящий сайт.
PAGE = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Урок 4. Смета которая усиливает вашу позицию</title>
<meta property="og:title" content="Урок 4. Смета которая усиливает вашу позицию">
</head><body><h1>Урок</h1><p id="s">…</p>
<script>
(async () => {{
  const say = (t) => document.getElementById("s").textContent = t;
  // ⚠ ОДНОВРЕМЕННО, а не по очереди: на живой странице два плеера стартуют
  // разом, и записи о находках наступают друг другу на пятки.
  await Promise.all([
    fetch("{MASTER}"),
    fetch("/api/playlist/master/{B1}/{B2}?user-cdn=cdnvideo&jwt=eyJ0eXAiOiJKV1Qi"),
  ]);
  await Promise.all([
    fetch("{MEDIA}"),
    fetch("/api/playlist/media/{B1}/{B2}/480?consumer=vod&sid="),
  ]);
  for (const n of [0, 1]) await fetch(`/api/storage/chunk/{H1}/{H2}/480/${{n}}.bin?host=vh-125`);
  await fetch("/pl/api/teach/lesson/comments");
  await fetch("/api/save-last-seen-time/set?current-time=99");
  await fetch("/subtitles/{H1}/internal/subtitles.vtt?version=0");
  say("плеер отработал");
}})();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path
        if path == "/":
            return self.send(PAGE, "text/html; charset=utf-8")
        if path.startswith("/api/playlist/master/"):
            # ⚠ Тип НАРОЧНО неправильный: сайт отдаёт плейлист как json.
            body = MASTER_BODY if H1 in path else MASTER_BODY.replace(H1, B1).replace(H2, B2)
            return self.send(body, "application/json")
        if path.startswith("/api/playlist/media/"):
            return self.send(MEDIA_BODY, "application/json")
        if path.startswith("/api/storage/chunk/"):
            return self.send("двоичный кусок", "application/octet-stream")
        return self.send("{}", "application/json")

    def send(self, body, ctype):
        data = body.encode("utf-8")
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
    # ⚠ Сервер ОБЯЗАН быть многопоточным. Страница тянет плейлисты одновременно,
    # и расширение тут же читает их само, чтобы опознать. Однопоточный сервер
    # обслуживает всё по очереди — одна из проверок изредка не успевала, и
    # мастер-плейлист терялся. Это был изъян стенда, а не расширения.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="videolov-gc-")

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
    # ⚠ Мало дождаться служебного скрипта — надо дождаться, пока он ПОДПИШЕТСЯ
    # на трафик. До этого мгновения запросы страницы проходят мимо, и проверка
    # падает «ничего не найдено» на ровном месте. В жизни это тот самый случай
    # «расширение только поставили — обнови страницу».
    for _ in range(40):
        if sw.evaluate("() => chrome.webRequest.onBeforeRequest.hasListeners()"):
            break
        sw.evaluate("() => new Promise((r) => setTimeout(r, 250))")

    page = ctx.new_page()
    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")

    tab_id = sw.evaluate(
        "async () => (await chrome.tabs.query({active: true, currentWindow: true}))[0].id"
    )

    # ⚠ Ждём РЕЗУЛЬТАТА, а не отмеренных секунд. Плейлист узнаётся чтением, то
    # есть через сеть, и на занятой машине это заметно дольше. Фиксированная
    # пауза давала осечку примерно раз на пять прогонов.
    found = []
    for _ in range(40):
        found = sw.evaluate(
            "async (id) => (await chrome.storage.session.get(`found:${id}`))[`found:${id}`] || []",
            tab_id,
        )
        if len(found) >= 2:
            break
        page.wait_for_timeout(500)
    for f in found:
        print(f"      найдено: [{f['kind']}] {f['url'][:95]}")

    check("плейлист без расширения найден", len(found) > 0, "ничего не найдено")
    if not found:
        log = sw.evaluate(
            "async () => (await chrome.storage.session.get('sightings')).sightings || []"
        )
        for e in log[-12:]:
            print(f"      журнал: {e['verdict']} | {e['url'][:90]}")
        return

    check("два разных ролика — две строки", len(found) == 2, f"строк: {len(found)}")

    # ⚠ Значок на иконке: с одним видео он показывался, с несколькими — нет.
    badge = sw.evaluate("async (id) => chrome.action.getBadgeText({tabId: id})", tab_id)
    check("на значке видно число находок", badge == str(len(found)), f"на значке «{badge}»")

    item = [f for f in found if H1 in f["url"]][0]
    check("это HLS", item["kind"] == "hls", item["kind"])
    check("выбран МАСТЕР, а не качество", "/master/" in item["url"], item["url"])
    check(
        "имя взято из заголовка урока",
        item["name"].startswith("Урок 4"),
        item["name"],
    )

    # ⚠ Счётчики журнала сохраняются с задержкой (пачкой раз в полторы
    # секунды, чтобы не дёргать хранилище на каждый запрос). Читать их сразу
    # после появления находок рано — ждём, пока доедут.
    counters = {}
    for _ in range(30):
        counters = sw.evaluate(
            "async () => (await chrome.storage.session.get('sightCounters')).sightCounters || {}"
        )
        if counters.get("segments", 0) >= 2:
            break
        page.wait_for_timeout(500)
    check("куски посчитаны как куски", counters.get("segments", 0) >= 2, counters)
    print(f"      счётчики: {counters.get('seen')} всего, {counters.get('taken')} видео, "
          f"{counters.get('segments')} кусков")


if __name__ == "__main__":
    main()
