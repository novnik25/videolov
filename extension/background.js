// Видеолов — фоновый скрипт. Находит видео, отдаёт задания помощнику, ведёт учёт.

import { classify, dedupKey, isKnownSite, sourceLabel } from "./lib/detect.js";
import { toFileName, nameFromUrl, siteFolder } from "./lib/title.js";
import * as store from "./lib/store.js";
import * as helper from "./lib/helper.js";
import { probeHls, qualityLabel } from "./lib/hls.js";

const MAX_PER_TAB = 30;

/* ---------------------------------------------------------------- находки */

/** Заголовки вкладок, присланные осмотром страницы. Кеш — переживает сон. */
async function rememberTitle(tabId, title) {
  if (!title) return;
  await chrome.storage.session.set({ [`title:${tabId}`]: title });
}

async function tabTitle(tabId) {
  const got = await chrome.storage.session.get(`title:${tabId}`);
  if (got[`title:${tabId}`]) return got[`title:${tabId}`];
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.title || "";
  } catch {
    return "";
  }
}

async function addFound(tabId, item) {
  const list = await store.getFound(tabId);
  if (list.some((x) => x.id === item.id)) return false;
  list.unshift(item);
  await store.setFound(tabId, list.slice(0, MAX_PER_TAB));
  await paintBadge(tabId);
  notifyPopup();
  return true;
}

async function paintBadge(tabId) {
  const list = await store.getFound(tabId);
  const jobs = Object.values(await store.getJobs());
  const running = jobs.filter((j) => j.status === "running").length;
  const text = running ? String(running) : list.length ? String(list.length) : "";
  const color = running ? "#f59e0b" : "#2563eb";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Вкладка успела закрыться — не беда.
  }
}

/** Перехват сети: основной способ увидеть поток. */
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const hit = classify(d.url);
    if (hit) void record(d.tabId, hit, d.initiator || "");
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
);

/** Второй заход — по Content-Type: бывают потоки без расширения в адресе. */
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
    const hit = classify(d.url, ct?.value || "");
    if (hit) void record(d.tabId, hit, d.initiator || "");
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"],
);

async function record(tabId, hit, initiator) {
  let pageUrl = initiator;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab?.url || initiator;
  } catch {
    /* вкладка закрылась */
  }
  // На известной площадке сырой поток не нужен: качаем страницу целиком.
  if (isKnownSite(pageUrl)) return;

  const title = await tabTitle(tabId);
  const item = {
    id: dedupKey(hit.url),
    kind: hit.kind,
    url: hit.url,
    pageUrl,
    title: title || nameFromUrl(hit.url),
    name: toFileName(title || nameFromUrl(hit.url)),
    label: sourceLabel(hit),
    at: Date.now(),
  };
  await addFound(tabId, item);
}

/** Осмотр страницы: заголовок и видео прямо в вёрстке. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === "scan") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") return;
    void (async () => {
      if (msg.top && msg.title) await rememberTitle(tabId, msg.title);
      if (isKnownSite(msg.pageUrl)) {
        const title = msg.title || (await tabTitle(tabId));
        await addFound(tabId, {
          id: `page:${msg.pageUrl}`,
          kind: "page",
          url: msg.pageUrl,
          pageUrl: msg.pageUrl,
          title,
          name: toFileName(title),
          label: "страница",
          at: Date.now(),
        });
        return;
      }
      for (const v of msg.videos || []) {
        const hit = classify(v.src);
        if (!hit) continue;
        const title = v.title || msg.title || (await tabTitle(tabId));
        await addFound(tabId, {
          id: dedupKey(v.src),
          kind: hit.kind,
          url: v.src,
          pageUrl: msg.pageUrl,
          title,
          name: toFileName(title || nameFromUrl(v.src)),
          label: sourceLabel(hit),
          duration: v.duration || 0,
          at: Date.now(),
        });
      }
    })();
    return; // ответ не нужен
  }

  // Всё остальное — запросы окна расширения.
  handlePopup(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // ответим асинхронно
});

/** Уход со страницы очищает список вкладки. */
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === "loading" && info.url) {
    await store.clearFound(tabId);
    await chrome.storage.session.remove(`title:${tabId}`);
    await paintBadge(tabId);
    notifyPopup();
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await store.clearFound(tabId);
  await chrome.storage.session.remove(`title:${tabId}`);
});
chrome.tabs.onActivated.addListener(({ tabId }) => void paintBadge(tabId));

/* ------------------------------------------------------------- загрузки */

function notifyPopup() {
  chrome.runtime.sendMessage({ cmd: "state-changed" }).catch(() => {});
}

/** Куки нужны и площадке с потоком, и странице: авторизация чаще на второй. */
async function collectCookies(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u) continue;
    let list = [];
    try {
      list = await chrome.cookies.getAll({ url: u });
    } catch {
      continue;
    }
    for (const c of list) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        domain: c.domain,
        hostOnly: Boolean(c.hostOnly),
        path: c.path || "/",
        secure: Boolean(c.secure),
        expires: c.session ? 0 : Math.round(c.expirationDate || 0),
        name: c.name,
        value: c.value,
      });
    }
  }
  return out;
}

async function jobContext(item) {
  const settings = await store.getSettings();
  return {
    url: item.url,
    kind: item.kind,
    pageUrl: item.pageUrl,
    site: siteFolder(item.pageUrl || item.url),
    headers: {
      Referer: item.pageUrl || item.url,
      "User-Agent": navigator.userAgent,
    },
    cookies: await collectCookies([item.url, item.pageUrl]),
    settings,
  };
}

async function findItem(tabId, itemId) {
  const list = await store.getFound(tabId);
  const item = list.find((x) => x.id === itemId);
  if (!item) throw new Error("видео пропало из списка — обнови страницу");
  return item;
}

async function handlePopup(msg) {
  switch (msg?.cmd) {
    case "state": {
      const tabId = msg.tabId;
      return {
        found: typeof tabId === "number" ? await store.getFound(tabId) : [],
        jobs: await store.getJobs(),
        history: await store.getHistory(),
        settings: await store.getSettings(),
      };
    }

    case "health":
      return helper.health();

    case "probe": {
      const item = await findItem(msg.tabId, msg.itemId);
      // Быстрый путь: мастер-плейлист HLS читается прямо здесь, без запуска процесса.
      if (item.kind === "hls") {
        try {
          const { variants, single } = await probeHls(item.url);
          if (single) return { formats: [{ id: "", label: "исходное", height: 0 }], fast: true };
          if (variants.length) {
            return {
              fast: true,
              formats: variants.map((v) => ({
                id: "",
                height: v.height,
                label: qualityLabel(v),
                bandwidth: v.bandwidth,
              })),
            };
          }
        } catch (e) {
          console.warn("[видеолов] плейлист не прочитался, спрошу помощника:", e.message);
        }
      }
      const ctx = await jobContext(item);
      return helper.call("probe", ctx, 60000);
    }

    case "download": {
      const item = await findItem(msg.tabId, msg.itemId);
      const ctx = await jobContext(item);
      const { jobId } = await helper.call("download", {
        ...ctx,
        name: toFileName(msg.name || item.name),
        mode: msg.mode || "av",
        formatId: msg.formatId || "",
        height: msg.height || 0,
      });
      await store.putJob({
        id: jobId,
        name: toFileName(msg.name || item.name),
        mode: msg.mode || "av",
        status: "running",
        percent: 0,
        speed: 0,
        eta: 0,
        startedAt: Date.now(),
      });
      await paintBadge(msg.tabId);
      notifyPopup();
      return { jobId };
    }

    case "cancel": {
      await helper.call("cancel", { jobId: msg.jobId }, 15000);
      await store.putJob({ id: msg.jobId, status: "cancelled" });
      notifyPopup();
      return { ok: true };
    }

    case "hide-job":
      await store.dropJob(msg.jobId);
      notifyPopup();
      return { ok: true };

    case "open-folder":
      return helper.call("openFolder", { path: msg.path }, 15000);

    case "play":
      return helper.call("play", { path: msg.path }, 15000);

    case "delete-file":
      return helper.call("deleteFile", { path: msg.path }, 15000);

    case "pick-folder": {
      const data = await helper.call("pickFolder", {}, 300000);
      if (data?.folder) await store.setSettings({ folder: data.folder });
      return data;
    }

    case "settings":
      return store.setSettings(msg.patch || {});

    case "clear-history":
      await store.clearHistory();
      return { ok: true };

    default:
      throw new Error(`неизвестная команда: ${msg?.cmd}`);
  }
}

/* ---------------------------------------- вести от помощника о загрузках */

helper.onEvent(async (ev) => {
  if (ev.kind === "disconnected") {
    const jobs = await store.getJobs();
    for (const j of Object.values(jobs)) {
      if (j.status === "running") {
        await store.putJob({ id: j.id, status: "error", error: "помощник отключился" });
      }
    }
    notifyPopup();
    return;
  }

  if (ev.kind === "progress") {
    // ⚠ Отменённую загрузку воскрешать нельзя. yt-dlp успевает выплюнуть
    // последние строки прогресса уже после того, как его убили, и они
    // возвращали карточке вид «качается» — навсегда, потому что больше
    // событий не будет. Поймано живой проверкой 16.09.2026.
    const current = (await store.getJobs())[ev.jobId];
    if (!current || current.status !== "running") return;
    await store.putJob({
      id: ev.jobId,
      status: "running",
      percent: ev.percent || 0,
      speed: ev.speed || 0,
      eta: ev.eta || 0,
      bytes: ev.bytes || 0,
      total: ev.total || 0,
      stage: ev.stage || "",
    });
    notifyPopup();
    return;
  }

  if (ev.kind === "done") {
    const jobs = await store.getJobs();
    const job = jobs[ev.jobId] || {};
    await store.putJob({ id: ev.jobId, status: "done", percent: 100, file: ev.file });
    await store.pushHistory({
      id: ev.jobId,
      name: job.name || ev.file,
      file: ev.file,
      site: ev.site || "",
      size: ev.size || 0,
      at: Date.now(),
    });
    notifyPopup();
    void refreshBadge();
    return;
  }

  if (ev.kind === "error") {
    await store.putJob({ id: ev.jobId, status: "error", error: ev.error });
    notifyPopup();
    void refreshBadge();
  }
});

async function refreshBadge() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await paintBadge(tab.id);
}
