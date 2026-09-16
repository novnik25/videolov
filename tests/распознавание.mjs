// Проверка распознавания: что считаем видео, что — мусором.
const BASE = "file:///C:/Users/novos/OneDrive/Документы/Claude/Projects/Видеолов/extension/lib/";
const { classify, dedupKey, isKnownSite } = await import(BASE + "detect.js");
const { parseMaster, isMaster } = await import(BASE + "hls.js");

let bad = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "ПЛОХО"} ${name}${ok ? "" : `\n      получил ${JSON.stringify(got)}\n      ждал   ${JSON.stringify(want)}`}`);
};

// --- что ловим ---
check("мастер-плейлист курса", classify("https://curs.example.ru/hls/lesson2/master.m3u8")?.kind, "hls");
check("плейлист с параметром", classify("https://cdn.ru/v/index.m3u8?token=abc")?.kind, "hls");
check("прямой mp4", classify("https://cdn.ru/files/lesson.mp4")?.kind, "file");
check("DASH", classify("https://cdn.ru/v/manifest.mpd")?.kind, "dash");
check("поток без расширения по типу", classify("https://cdn.ru/stream?id=9", "application/vnd.apple.mpegurl")?.kind, "hls");
check("видео по Content-Type", classify("https://cdn.ru/get?id=9", "video/mp4")?.kind, "file");

// --- что НЕ ловим ---
check("сегмент .ts", classify("https://cdn.ru/hls/seg-00042.ts"), null);
check("сегмент .m4s", classify("https://cdn.ru/dash/chunk-1.m4s"), null);
check("инициализация DASH", classify("https://cdn.ru/dash/init.mp4"), null);
check("сегмент с именем fragment", classify("https://cdn.ru/v/fragment-12.mp4"), null);
check("субтитры", classify("https://cdn.ru/subs/ru.vtt"), null);
check("картинка", classify("https://cdn.ru/img/poster.jpg"), null);
check("куски ютуба", classify("https://rr3---sn-x.googlevideo.com/videoplayback?x=1&mime=video/mp4"), null);

// --- склейка повторов ---
check(
  "один плейлист с разными метками времени",
  dedupKey("https://cdn.ru/v/index.m3u8?token=a&_=111") === dedupKey("https://cdn.ru/v/index.m3u8?token=a&_=222"),
  true,
);
check(
  "разные токены — разные видео",
  dedupKey("https://cdn.ru/v/index.m3u8?token=a") === dedupKey("https://cdn.ru/v/index.m3u8?token=b"),
  false,
);

// --- известные площадки ---
check("ютуб", isKnownSite("https://www.youtube.com/watch?v=abc"), true);
check("вк видео", isKnownSite("https://vkvideo.ru/video-1_2"), true);
check("курс — не известная площадка", isKnownSite("https://curs.kudryavtsevtony.ru/lesson/2"), false);

// --- разбор мастер-плейлиста ---
const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Russian",URI="a1/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://cdn2.example.ru/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360/index.m3u8`;

check("это мастер", isMaster(master), true);
const vars = parseMaster(master, "https://cdn.example.ru/hls/master.m3u8");
check("качеств найдено", vars.length, 3);
check("по убыванию", vars.map((v) => v.height), [1080, 720, 360]);
check("относительный путь развёрнут", vars[1].url, "https://cdn.example.ru/hls/720/index.m3u8");
check("абсолютный путь сохранён", vars[0].url, "https://cdn2.example.ru/1080/index.m3u8");
check("запятая внутри CODECS не сломала разбор", vars[1].bandwidth, 2400000);

const media = "#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n#EXTINF:6.0,\nseg2.ts";
check("поток сегментов — не мастер", isMaster(media), false);

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
