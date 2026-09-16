// Видеолов — фоновый скрипт. Находит видео, отдаёт задания помощнику, ведёт учёт.

import {
  classify,
  classifyDetailed,
  dedupKey,
  isInsideOf,
  isKnownSite,
  looksMaster,
  mediaIdentity,
  sourceLabel,
} from "./lib/detect.js";
import * as sightings from "./lib/sightings.js";
import * as area from "./lib/area.js";
import { BUILD } from "./lib/build.js";
import { toFileName, nameFromUrl, siteFolder } from "./lib/title.js";
import * as store from "./lib/store.js";
import * as helper from "./lib/helper.js";
import { probeHls, qualityLabel } from "./lib/hls.js";

/* ------------------------------------------------- подписки первым делом ---
 *
 * ⚠ Manifest V3 запоминает, на какие события расширение подписано, по ПЕРВОМУ
 * запуску служебного скрипта — и будит его потом только ради них. Подписка,
 * сделанная позже (после await, из обработчика, из лениво загруженного модуля),
 * браузером не учитывается: скрипт спит, события проходят мимо, а снаружи это
 * выглядит как «расширение ничего не находит».
 *
 * Поэтому здесь стоят ПУСТЫЕ подписки — до всякой другой работы. Настоящие
 * обработчики добавляются ниже. Тот же приём применяет Video DownloadHelper,
 * который на этом браузере работает (разобран 16.09.2026).
 */
const WEB_FILTER = {
  urls: ["<all_urls>"],
  types: ["media", "xmlhttprequest", "object", "other"],
};
chrome.webRequest.onBeforeRequest.addListener(() => {}, WEB_FILTER);
chrome.webRequest.onResponseStarted.addListener(() => {}, WEB_FILTER, ["responseHeaders"]);
chrome.webRequest.onHeadersReceived.addListener(() => {}, WEB_FILTER, ["responseHeaders"]);
chrome.runtime.onMessage.addListener(() => {});
chrome.tabs.onUpdated.addListener(() => {});
chrome.tabs.onRemoved.addListener(() => {});
chrome.tabs.onActivated.addListener(() => {});

const MAX_PER_TAB = 30;

/* ------------------------------------------------------------ самопроверка */

// ⚠ Всё это пишется в chrome.storage.local — она есть всегда. Смысл в том,
// чтобы отличить «перехват не сработал» от «сработал, но запись потерялась»:
// обе беды выглядят как пустой список, а первая живёт в браузере, вторая — в
// хранилище. Метка последнего запроса переживает перезапуск служебного скрипта.
const bootAt = Date.now();
let lastRequestWrite = 0;

chrome.storage.local
  .get(["swStarts"])
  .then((got) => chrome.storage.local.set({ swStarts: (got.swStarts || 0) + 1, swBootAt: bootAt }))
  .catch(() => {});

function markRequestSeen() {
  const now = Date.now();
  if (now - lastRequestWrite < 2000) return; // не долбим хранилище на каждый запрос
  lastRequestWrite = now;
  chrome.storage.local.set({ lastRequestAt: now }).catch(() => {});
}

/* ---------------------------------------------------------------- находки */

/** Заголовки вкладок, присланные осмотром страницы. Кеш — переживает сон. */
async function rememberTitle(tabId, title) {
  if (!title) return;
  await area.set({ [`title:${tabId}`]: title });
}

async function tabTitle(tabId) {
  const got = await area.get(`title:${tabId}`);
  if (got[`title:${tabId}`]) return got[`title:${tabId}`];
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.title || "";
  } catch {
    return "";
  }
}

/**
 * Очередь записи по вкладкам.
 * ⚠ Находка добавляется «прочитал список — изменил — записал». Два плеера на
 * странице стартуют одновременно, оба читают ПУСТОЙ список и оба пишут свой
 * единственный элемент — второй затирает первого, и одно из видео пропадает.
 * Записи по одной вкладке выстраиваются в цепочку.
 */
const queues = new Map();

function inQueue(tabId, work) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.then(work, work);
  queues.set(
    tabId,
    next.catch(() => {}),
  );
  return next;
}

function addFound(tabId, item) {
  return inQueue(tabId, () => addFoundNow(tabId, item));
}

async function addFoundNow(tabId, item) {
  let list = await store.getFound(tabId);
  if (list.some((x) => x.id === item.id)) return false;

  // Одно видео — одна строка. Плеер тянет мастер-плейлист, за ним плейлисты
  // каждого качества и файлы инициализации; все они лежат ВНУТРИ папки мастера.
  // Ребёнок при живом родителе не показывается, а пришедший родитель забирает
  // место у уже показанных детей.
  if (item.kind !== "page") {
    const media = (x) => x.kind !== "page";
    if (list.some((x) => media(x) && isInsideOf(item.url, x.url))) return false;
    list = list.filter((x) => !(media(x) && isInsideOf(x.url, item.url)));

    // Тот же ролик под другим адресом: у GetCourse мастер и плейлист качества
    // лежат в разных папках, но несут одни хеши. Родства по вложенности нет —
    // спасает только опознавательный знак. Главным считается мастер.
    const mark = mediaIdentity(item.url);
    if (mark) {
      const twin = list.findIndex((x) => media(x) && mediaIdentity(x.url) === mark);
      if (twin >= 0) {
        if (!(looksMaster(item.url) && !looksMaster(list[twin].url))) return false;
        list.splice(twin, 1);
      }
    }
  }

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
    markRequestSeen();
    const out = classifyDetailed(d.url);
    // ⚠ tabId −1 — это запрос служебного работника сайта, не вкладки. Показать
    // его негде, но в журнале он виден: иначе «перехват молчит» неотличимо от
    // «перехват работает, а привязать не к чему».
    if (d.tabId < 0) {
      void sightings.note(d.url, d.type, d.tabId, "вне вкладки", false, out.segment);
      return;
    }
    // Похоже на плейлист — читаем и решаем по содержимому, а не по адресу.
    // Проверяем только то, что запрашивалось методом GET: повторять POST своим
    // запросом нельзя — это чужое действие, а не чтение.
    if (out.maybe) {
      if ((d.method || "GET").toUpperCase() === "GET") {
        void checkMaybe(d.url, d.type, d.tabId, d.initiator || "");
      } else {
        void sightings.note(d.url, d.type, d.tabId, `похоже на плейлист, но ${d.method}`, false);
      }
      return;
    }
    if (!out.kind) {
      void sightings.note(d.url, d.type, d.tabId, out.reason, false, out.segment);
      return;
    }
    // Приговор пишем ПОСЛЕ попытки добавить: «узнали формат» и «показали
    // человеку» — разные вещи, и счётчик обязан считать вторую. Иначе куски
    // одного ролика раздувают число находок в десятки раз.
    void (async () => {
      const added = await record(d.tabId, out, d.initiator || "");
      await sightings.note(
        d.url,
        d.type,
        d.tabId,
        added ? out.kind : "часть уже найденного видео",
        added,
      );
    })();
  },
  WEB_FILTER,
);

/**
 * Третий заход — момент, когда ответ пошёл.
 * Ловит то, что не видно по адресу: тип содержимого известен, а сам запрос
 * заведомо состоялся. Именно на этом событии построен VDH.
 */
chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    markRequestSeen();
    if (d.tabId < 0) return;
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
    const hit = classify(d.url, ct?.value || "");
    if (hit) void record(d.tabId, hit, d.initiator || "");
  },
  WEB_FILTER,
  ["responseHeaders"],
);

/** Второй заход — по Content-Type: бывают потоки без расширения в адресе. */
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
    const hit = classify(d.url, ct?.value || "");
    if (hit) void record(d.tabId, hit, d.initiator || "");
  },
  WEB_FILTER,
  ["responseHeaders"],
);

/**
 * Проверка адреса, ПОХОЖЕГО на плейлист.
 *
 * ⚠ Расширение .m3u8 — привычка, а не правило: GetCourse отдаёт плейлист как
 * /api/playlist/master/<хеш>/<хеш>?jwt=…, и по адресу он неотличим от любого
 * другого запроса к API. Поэтому решает не адрес, а содержимое: настоящий
 * плейлист начинается с #EXTM3U. Ответ запоминается, чтобы не тянуть один и
 * тот же адрес дважды.
 */
const verdicts = new Map(); // адрес → обещание с ответом

function readPlaylist(url) {
  let p = verdicts.get(url);
  if (p) return p;
  p = (async () => {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return { kind: "", why: `ответ ${res.status}` };
      const head = (await res.text()).slice(0, 2048);
      if (/^\s*#EXTM3U/.test(head)) return { kind: "hls", why: "" };
      if (/<MPD[\s>]/i.test(head)) return { kind: "dash", why: "" };
      return { kind: "", why: "не плейлист" };
    } catch (e) {
      return { kind: "", why: `не прочитался: ${String(e.message || e).slice(0, 60)}` };
    }
  })();
  verdicts.set(url, p);
  return p;
}

async function checkMaybe(url, type, tabId, initiator) {
  const { kind, why } = await readPlaylist(url);
  if (!kind) {
    await sightings.note(url, type, tabId, `проверен: ${why}`, false);
    return;
  }
  const added = await record(tabId, { kind, url }, initiator);
  await sightings.note(
    url,
    type,
    tabId,
    added ? `${kind} — узнан по содержимому` : "часть уже найденного видео",
    added,
  );
}

/** @returns {Promise<boolean>} попала ли находка в список вкладки */
async function record(tabId, hit, initiator) {
  let pageUrl = initiator;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab?.url || initiator;
  } catch {
    /* вкладка закрылась */
  }
  // На известной площадке сырой поток не нужен: качаем страницу целиком.
  if (isKnownSite(pageUrl)) return false;

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
  return addFound(tabId, item);
}

/** Осмотр страницы: заголовок и видео прямо в вёрстке. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === "scan") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") return;
    void (async () => {
      if (msg.top && msg.title) await rememberTitle(tabId, msg.title);
      if (msg.poster) await area.set({ [`poster:${tabId}`]: msg.poster });
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
    await area.remove(`title:${tabId}`);
    await paintBadge(tabId);
    notifyPopup();
  }
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await store.clearFound(tabId);
  await area.remove(`title:${tabId}`);
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
      const found = typeof tabId === "number" ? await store.getFound(tabId) : [];
      // Обложка приезжает осмотром страницы — часто ПОЗЖЕ самой находки,
      // поэтому подставляется здесь, а не вшивается в неё навсегда.
      if (found.length && typeof tabId === "number") {
        const got = await area.get(`poster:${tabId}`);
        const poster = got[`poster:${tabId}`];
        if (poster) for (const f of found) if (!f.poster) f.poster = poster;
      }
      return {
        found,
        // Пустому списку нужна причина: «тут нет видео» и «видео есть, но его
        // плейлист прошёл мимо» — разные беды с разным лечением.
        hint: found.length || typeof tabId !== "number" ? "" : await sightings.hintForTab(tabId),
        jobs: await store.getJobs(),
        history: await store.getHistory(),
        settings: await store.getSettings(),
      };
    }

    case "build":
      // Отдельная лёгкая команда: по ней страницы узнают, не устарела ли
      // начинка. Старый служебный скрипт такой команды не знает — и это тоже
      // ответ: значит он старый.
      return { build: BUILD };

    case "health":
      return helper.health();

    case "sightings":
      return sightings.readLog();

    case "selfcheck": {
      const local = await chrome.storage.local.get(["swStarts", "lastRequestAt", "swBootAt"]);
      let granted = null;
      try {
        granted = await chrome.permissions.getAll();
      } catch (e) {
        granted = { error: String(e.message || e) };
      }
      return {
        build: BUILD,
        // Зарегистрирован ли перехватчик прямо сейчас. Если false — виноват
        // не сайт и не разбор, а сам запуск служебного скрипта.
        webRequestApi: typeof chrome.webRequest,
        listenerOn: Boolean(chrome.webRequest?.onBeforeRequest?.hasListeners?.()),
        headersListenerOn: Boolean(chrome.webRequest?.onHeadersReceived?.hasListeners?.()),
        swStarts: local.swStarts || 0,
        swAliveSec: Math.round((Date.now() - bootAt) / 1000),
        lastRequestAt: local.lastRequestAt || 0,
        storage: await area.describe(),
        manifestPermissions: chrome.runtime.getManifest().permissions,
        grantedPermissions: granted,
        browser: navigator.userAgent,
      };
    }

    case "clear-sightings":
      await sightings.clearLog();
      return { ok: true };

    case "tabs-overview": {
      // Для страницы диагностики: что расширение видит по КАЖДОЙ вкладке.
      const tabs = await chrome.tabs.query({});
      const out = [];
      for (const t of tabs) {
        if (t.id == null) continue;
        const found = await store.getFound(t.id);
        out.push({ id: t.id, title: t.title || "", url: t.url || "", found: found.length });
      }
      return { tabs: out };
    }

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
        poster: msg.poster || item.poster || "",
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
    await store.pushHistory({
      id: ev.jobId,
      name: job.name || ev.file,
      file: ev.file,
      site: ev.site || "",
      size: ev.size || 0,
      poster: job.poster || "",
      mode: job.mode || "av",
      at: Date.now(),
    });
    // ⚠ Карточку убираем сами. Раньше готовая загрузка висела с галочкой
    // «готово», пока человек не нажмёт крестик, — и та же самая запись
    // одновременно стояла в истории. Два места про одно событие.
    await store.dropJob(ev.jobId);
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
