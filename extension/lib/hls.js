// Чтение мастер-плейлиста HLS прямо в расширении.
//
// Зачем не спросить yt-dlp: он ответит то же самое, но через запуск процесса —
// 1–3 секунды на каждое видео. Мастер-плейлист весит пару килобайт и читается
// мгновенно, а список качеств нужен сразу при открытии окна.

/** Разбирает текст мастер-плейлиста в список качеств. */
export function parseMaster(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
    // Адрес варианта — ближайшая непустая строка без решётки.
    let uri = "";
    for (let j = i + 1; j < lines.length; j++) {
      const c = lines[j].trim();
      if (!c) continue;
      if (c.startsWith("#")) continue;
      uri = c;
      break;
    }
    if (!uri) continue;
    const res = String(attrs.RESOLUTION || "");
    const height = Number(res.split("x")[1] || 0);
    out.push({
      height,
      width: Number(res.split("x")[0] || 0),
      bandwidth: Number(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || 0),
      url: absolute(uri, baseUrl),
    });
  }
  out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return out;
}

/**
 * Одно разрешение — одна строка списка.
 * В мастер-плейлисте варианты одного размера повторяются: разные кодеки, разные
 * группы звука, разный битрейт. В выпадашке это выглядело как «1080p» девять
 * раз подряд — выбрать нельзя, понять нечего. Оставляем самый жирный поток
 * каждого разрешения. Поймано живой проверкой 16.09.2026.
 */
export function bestPerHeight(variants) {
  const best = new Map();
  for (const v of variants) {
    const prev = best.get(v.height);
    if (!prev || v.bandwidth > prev.bandwidth) best.set(v.height, v);
  }
  return [...best.values()].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

/** Похоже ли это на плейлист вообще. */
export function looksLikePlaylist(text) {
  return /^\s*#EXTM3U/.test(String(text));
}

/** Мастер (список качеств) или уже поток сегментов. */
export function isMaster(text) {
  return /#EXT-X-STREAM-INF:/.test(String(text));
}

function parseAttrs(s) {
  const out = {};
  // Значения бывают в кавычках и содержат запятые (CODECS="avc1.64001f,mp4a.40.2").
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function absolute(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/**
 * Скачивает плейлист и возвращает качества.
 * Куки шлём: у закрытых курсов без них приедет 403.
 */
export async function probeHls(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`плейлист отдал ${res.status}`);
  const text = await res.text();
  if (!looksLikePlaylist(text)) throw new Error("это не плейлист HLS");
  if (!isMaster(text)) return { variants: [], single: true };
  return { variants: bestPerHeight(parseMaster(text, url)), single: false };
}

/** Подпись качества для списка: «1080p», «720p», «исходное». */
export function qualityLabel(v) {
  if (v.height) return `${v.height}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} кбит/с`;
  return "исходное";
}
