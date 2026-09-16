// Состояние расширения.
//
// ⚠ Фоновый скрипт Manifest V3 засыпает через ~30 секунд без событий, и всё, что
// лежало в переменных, пропадает. Поэтому найденное на вкладках живёт в
// chrome.storage.session (умирает вместе с браузером — ровно тот срок, что нужен),
// а настройки и история загрузок — в chrome.storage.local.

const SESSION = chrome.storage.session;
const LOCAL = chrome.storage.local;

export const DEFAULT_SETTINGS = {
  folder: "", // пусто = помощник подставит «Загрузки\Видеолов»
  perSite: true, // раскладывать по папкам сайта
  threads: 16, // сколько кусков тянуть разом
  audioFormat: "mp3", // во что превращать «только звук»
};

export async function getSettings() {
  const got = await LOCAL.get("settings");
  return { ...DEFAULT_SETTINGS, ...(got.settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await LOCAL.set({ settings: next });
  return next;
}

/* ---------- найденное на вкладке ---------- */

const foundKey = (tabId) => `found:${tabId}`;

export async function getFound(tabId) {
  const got = await SESSION.get(foundKey(tabId));
  return got[foundKey(tabId)] || [];
}

export async function setFound(tabId, list) {
  await SESSION.set({ [foundKey(tabId)]: list });
}

export async function clearFound(tabId) {
  await SESSION.remove(foundKey(tabId));
}

/* ---------- загрузки ---------- */

export async function getJobs() {
  const got = await SESSION.get("jobs");
  return got.jobs || {};
}

export async function putJob(job) {
  const jobs = await getJobs();
  jobs[job.id] = { ...(jobs[job.id] || {}), ...job };
  await SESSION.set({ jobs });
  return jobs[job.id];
}

export async function dropJob(id) {
  const jobs = await getJobs();
  delete jobs[id];
  await SESSION.set({ jobs });
}

/* ---------- история ---------- */

const HISTORY_LIMIT = 50;

export async function getHistory() {
  const got = await LOCAL.get("history");
  return got.history || [];
}

export async function pushHistory(entry) {
  const list = await getHistory();
  list.unshift(entry);
  await LOCAL.set({ history: list.slice(0, HISTORY_LIMIT) });
}

export async function clearHistory() {
  await LOCAL.set({ history: [] });
}
