// Распознавание: что из сетевого трафика вкладки вообще является видео.
//
// Задача модуля — отделить ЦЕЛЬНОЕ видео (плейлист или файл) от его кусков.
// HLS-поток на часовой урок — это тысячи запросов .ts; если пускать их в список,
// список превращается в мусор, а нужная строка в нём тонет.

/** Площадки, которые yt-dlp знает лучше нас: их качаем по адресу СТРАНИЦЫ. */
const KNOWN_SITES = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)vk\.com$/i,
  /(^|\.)vkvideo\.ru$/i,
  /(^|\.)rutube\.ru$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)dzen\.ru$/i,
  /(^|\.)ok\.ru$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)tiktok\.com$/i,
];

/** Хосты раздачи кусков известных площадок — их сырые потоки не показываем. */
const NOISE_HOSTS = [
  /(^|\.)googlevideo\.com$/i,
  /(^|\.)ytimg\.com$/i,
  /(^|\.)doubleclick\.net$/i,
];

/** Куски потока: одиночный сегмент, а не видео. */
// ⚠ .bin и /chunk/ — из живого разбора GetCourse: куски там называются
// 34.bin и лежат в /api/storage/chunk/. Ни одного привычного .ts на сайте нет.
const SEGMENT = /\.(ts|m4s|aac|vtt|srt|key|bin)(\?|$)|\/chunk\//i;
const SEGMENT_HINT =
  /(^|[/_-])(seg|segment|chunk|frag|fragment|init|fileSequence|media)[\d_-]*\.(mp4|m4a|webm)(\?|$)/i;

/** Цельные файлы, которые можно скачать как есть. */
const WHOLE_FILE = /\.(mp4|webm|mov|mkv|avi|flv|m4v|mpg|mpeg|wmv|m4a|mp3|ogg|wav)(\?|$)/i;
const HLS = /\.m3u8(\?|$)/i;

/**
 * Адреса, ПОХОЖИЕ на плейлист, хотя расширения у них нет.
 * ⚠ Расширение .m3u8 — не обязательное свойство, а привычка. GetCourse отдаёт
 * плейлист как /api/playlist/master/<хеш>/<хеш>?jwt=…, и по виду адреса он
 * неотличим от обычного запроса к API. Такие адреса не объявляются видео
 * сразу — они ПРОВЕРЯЮТСЯ чтением: настоящий плейлист начинается с #EXTM3U.
 * Найдено живым разбором 16.09.2026.
 */
const PLAYLIST_HINT =
  /\/(playlist|manifest|master|chunklist|hls|dash|stream)(\/|\?|$)|[?&](playlist|manifest)=/i;
const DASH = /\.mpd(\?|$)/i;

export function isKnownSite(pageUrl) {
  try {
    return KNOWN_SITES.some((re) => re.test(new URL(pageUrl).hostname));
  } catch {
    return false;
  }
}

/**
 * Что это за адрес — с объяснением решения.
 * Объяснение нужно журналу перехвата: без него «ничего не нашлось» неотличимо
 * от «нашлось, но отброшено», а лечится это противоположными способами.
 * @returns {{kind: "hls"|"dash"|"file", url: string} | {reason: string, segment?: boolean}}
 */
export function classifyDetailed(url, contentType = "") {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return { reason: "адрес не разобрался" };
  }
  if (NOISE_HOSTS.some((re) => re.test(host))) return { reason: "раздача кусков площадки" };
  if (SEGMENT.test(url) || SEGMENT_HINT.test(url)) {
    return { reason: "кусок потока", segment: true };
  }

  if (HLS.test(url) || /mpegurl/i.test(contentType)) return { kind: "hls", url };
  if (DASH.test(url) || /dash\+xml/i.test(contentType)) return { kind: "dash", url };
  if (WHOLE_FILE.test(url)) return { kind: "file", url };
  // Content-Type — последняя надежда: бывают потоки вообще без расширения.
  if (/^video\//i.test(contentType) || /^audio\//i.test(contentType)) {
    return { kind: "file", url };
  }
  // Похоже на плейлист, но утверждать рано — надо прочитать.
  if (PLAYLIST_HINT.test(url)) return { maybe: "playlist", url };

  return { reason: contentType ? `не видео (${contentType.slice(0, 40)})` : "не видео" };
}

/**
 * Что это за адрес. Возвращает null, если адрес видео не является.
 * @returns {{kind: "hls"|"dash"|"file", url: string} | null}
 */
export function classify(url, contentType = "") {
  const out = classifyDetailed(url, contentType);
  return out.kind ? out : null;
}

/**
 * Опознавательный знак ролика: длинные шестнадцатеричные куски адреса.
 * У GetCourse мастер-плейлист и плейлист качества лежат в РАЗНЫХ папках
 * (/playlist/master/… и /playlist/media/…), то есть по вложенности не
 * родственники, — но несут одни и те же хеши ролика. Без этого один урок
 * давал бы две строки.
 */
export function mediaIdentity(url) {
  const found = String(url).match(/[0-9a-f]{16,}/gi);
  return found ? found.slice(0, 3).join("|").toLowerCase() : "";
}

/** Похож ли адрес на ГЛАВНЫЙ плейлист (со списком качеств). */
export function looksMaster(url) {
  return /master/i.test(String(url));
}

/**
 * Лежит ли адрес ВНУТРИ папки другого — то есть является ли он его частью.
 * Мастер-плейлист живёт в `/курс/урок2/master.m3u8`, а его качества — в
 * `/курс/урок2/720/index.m3u8`. Без этой проверки одно видео даёт семь строк:
 * мастер, каждое качество и файлы инициализации по отдельности. Замерено на
 * живом плеере 16.09.2026.
 */
export function isInsideOf(childUrl, parentUrl) {
  try {
    const child = new URL(childUrl);
    const parent = new URL(parentUrl);
    if (child.origin !== parent.origin) return false;
    const dir = parent.pathname.slice(0, parent.pathname.lastIndexOf("/") + 1);
    if (!dir || dir === "/") return false;
    return child.pathname.startsWith(dir) && child.pathname !== parent.pathname;
  } catch {
    return false;
  }
}

/**
 * Ключ для склейки повторов. Плеер просит один и тот же плейлист десятки раз,
 * иногда с меняющимся параметром вроде _=1735… — по голому адресу такие строки
 * размножаются. Сравниваем адрес без временных меток.
 */
export function dedupKey(url) {
  try {
    const u = new URL(url);
    const drop = ["_", "t", "ts", "time", "rand", "r", "cachebuster", "nocache"];
    for (const p of drop) u.searchParams.delete(p);
    return u.origin + u.pathname + "?" + u.searchParams.toString();
  } catch {
    return url;
  }
}

/** Человеческое имя источника — показывается в списке под заголовком. */
export function sourceLabel(item) {
  if (item.kind === "page") return "страница";
  if (item.kind === "hls") return "HLS";
  if (item.kind === "dash") return "DASH";
  try {
    const m = new URL(item.url).pathname.match(/\.([a-z0-9]{2,4})(?:$|\?)/i);
    return m ? m[1].toUpperCase() : "файл";
  } catch {
    return "файл";
  }
}
