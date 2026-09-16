// Из заголовка страницы — в имя файла, пригодное для Windows.

/** Хвосты площадок, которые в имени файла не нужны. */
const SUFFIXES = [
  /\s*[-—–|]\s*YouTube\s*$/i,
  /\s*[-—–|]\s*VK Видео\s*$/i,
  /\s*[-—–|]\s*Rutube\s*$/i,
  /\s*[-—–|]\s*Дзен\s*$/i,
  /\s*[-—–|]\s*смотреть онлайн\s*$/i,
];

/** Управляющие символы: в имени файла недопустимы, а из вёрстки прилетают. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Приводит заголовок к безопасному имени файла.
 * Windows запрещает \ / : * ? " < > | и не терпит точку/пробел в конце.
 * Знак % убираем отдельно: yt-dlp читает его в шаблоне имени как поле.
 */
export function toFileName(raw, fallback = "video") {
  let s = String(raw || "").trim();
  for (const re of SUFFIXES) s = s.replace(re, "");
  s = s
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/%/g, "")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  // 150 символов: с папкой и расширением укладываемся в лимит пути Windows.
  if (s.length > 150) s = s.slice(0, 150).trim();
  return s || fallback;
}

/** Имя по адресу — когда заголовка нет вовсе. */
export function nameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return toFileName(decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, ""));
  } catch {
    return "video";
  }
}

/** Имя папки сайта: домен без www. */
export function siteFolder(pageUrl) {
  try {
    return toFileName(new URL(pageUrl).hostname.replace(/^www\./i, ""), "сайт");
  } catch {
    return "сайт";
  }
}
