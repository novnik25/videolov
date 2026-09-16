// Осмотр страницы: заголовок для имени файла и видео, вставленные прямо в вёрстку.
//
// Сетевой перехват в фоне ловит потоки, но не знает, как назвать файл. Название
// живёт здесь — в og:title, заголовке вкладки и ближайшем <h1>.

const DEBOUNCE_MS = 700;
let timer = null;

function pageTitle() {
  const og = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
  const ogText = og?.getAttribute("content")?.trim();
  if (ogText) return ogText;
  const h1 = document.querySelector("h1")?.textContent?.trim();
  if (document.title && document.title.trim()) return document.title.trim();
  return h1 || "";
}

/**
 * Обложка урока: по ней в списке видно, ЧТО именно скачиваешь.
 * Берём в порядке надёжности: постер плеера, og:image, ссылка на превью.
 */
function pagePoster() {
  const video = document.querySelector("video[poster]");
  if (video?.poster) return absolute(video.poster);
  const meta = document.querySelector(
    'meta[property="og:image"], meta[name="og:image"], meta[property="twitter:image"]',
  );
  const content = meta?.getAttribute("content")?.trim();
  if (content) return absolute(content);
  const link = document.querySelector('link[rel="image_src"]')?.getAttribute("href");
  return link ? absolute(link) : "";
}

function absolute(src) {
  try {
    const u = new URL(src, location.href);
    // data: и blob: показывать можно, но в список они не годятся: первые
    // раздувают хранилище, вторые мертвы вне своей страницы.
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

function videoTitle(el) {
  // Подпись рядом с плеером бывает точнее заголовка вкладки.
  const labelled = el.getAttribute("title") || el.getAttribute("aria-label");
  if (labelled && labelled.trim()) return labelled.trim();
  return "";
}

function collect() {
  const videos = [];
  for (const el of document.querySelectorAll("video")) {
    const srcs = [el.currentSrc, el.src];
    for (const s of el.querySelectorAll("source")) srcs.push(s.src);
    for (const raw of srcs) {
      const src = String(raw || "");
      // blob: и MediaSource скачать нельзя — исходный поток ловит перехватчик.
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) continue;
      videos.push({
        src,
        poster: el.poster || "",
        duration: Number.isFinite(el.duration) ? Math.round(el.duration) : 0,
        title: videoTitle(el),
      });
    }
  }
  return videos;
}

function report() {
  try {
    chrome.runtime.sendMessage({
      cmd: "scan",
      title: pageTitle(),
      poster: pagePoster(),
      pageUrl: location.href,
      top: window.top === window,
      videos: collect(),
    });
  } catch {
    // Расширение перезагрузили — страница переживёт это молча.
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(report, DEBOUNCE_MS);
}

schedule();
new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
document.addEventListener("loadedmetadata", schedule, true);
