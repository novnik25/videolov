// Журнал перехвата: что видел фоновый скрипт и что он о каждом запросе решил.
// Нужен, чтобы отличить две совершенно разные беды, которые снаружи выглядят
// одинаково («ничего не находит») и лечатся противоположно:
//
//   журнал пуст               → перехват не работает (права, спящий скрипт, браузер);
//   журнал полон, находок нет → перехват работает, а разбор не узнаёт формат.
//
// ⚠ Куски потока в журнал целиком не пишем: их тысячи в минуту, и они вытеснили
// бы ровно те строки, ради которых журнал заведён. От них хватает счётчика и
// пары примеров — они доказывают, что перехват жив.

import * as area from "./area.js";

const MAX = 300;
const SEGMENT_SAMPLES = 5;
const FLUSH_MS = 1500;

const empty = () => ({
  seen: 0,
  taken: 0,
  dropped: 0,
  segments: 0,
  startedAt: Date.now(),
  // Счёт по вкладкам: нужен, чтобы отличить «на странице нет видео» от
  // «видео идёт, но его плейлист запрошен ДО того, как расширение включилось».
  // Снаружи обе выглядят как пустой список, а лечатся по-разному.
  perTab: {},
});

let ring = [];
let segmentSamples = [];
let counters = empty();
let dirty = false;
let timer = null;
let loaded = false;

/** Поднимаем журнал с прошлого пробуждения: фоновый скрипт засыпает каждые 30 с. */
async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const got = await area.get(["sightings", "sightSamples", "sightCounters"]);
    if (Array.isArray(got.sightings)) ring = got.sightings;
    if (Array.isArray(got.sightSamples)) segmentSamples = got.sightSamples;
    if (got.sightCounters) counters = got.sightCounters;
  } catch {
    /* хранилище сессии могло ещё не завестись */
  }
}

function flushSoon() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await area.set({
        sightings: ring,
        sightSamples: segmentSamples,
        sightCounters: counters,
      });
    } catch {
      /* переживём */
    }
  }, FLUSH_MS);
}

/**
 * Записать увиденное.
 * @param {string} verdict  «hls» / «файл» / причина отказа
 * @param {boolean} taken   попало ли в список находок
 * @param {boolean} segment это кусок потока (пишем только счётчиком)
 */
export async function note(url, type, tabId, verdict, taken, segment = false) {
  await ensureLoaded();
  counters.seen++;
  taken ? counters.taken++ : counters.dropped++;

  if (tabId >= 0) {
    if (!counters.perTab) counters.perTab = {};
    const t = (counters.perTab[tabId] ||= { seen: 0, media: 0, taken: 0 });
    t.seen++;
    if (segment || taken || verdict === "часть уже найденного видео") t.media++;
    if (taken) t.taken++;
  }

  if (segment) {
    counters.segments++;
    if (segmentSamples.length < SEGMENT_SAMPLES) {
      segmentSamples.push(String(url).slice(0, 200));
      flushSoon();
    } else if (counters.segments % 200 === 0) {
      flushSoon(); // изредка сохраняем счётчик, не тревожа хранилище на каждый кусок
    }
    return;
  }

  ring.push({ at: Date.now(), url: String(url).slice(0, 300), type, tabId, verdict, taken });
  if (ring.length > MAX) ring = ring.slice(-MAX);
  flushSoon();
}

/**
 * Подсказка для пустого окна: почему на этой вкладке ничего нет.
 * Возвращает "" , когда сказать нечего.
 */
export async function hintForTab(tabId) {
  await ensureLoaded();
  const t = counters.perTab?.[tabId];
  // ⚠ Отсутствие записи — это НЕ «сказать нечего», а самый важный случай:
  // вкладка открыта раньше расширения, и весь её трафик прошёл мимо. Первая
  // версия возвращала здесь пустоту и молчала ровно там, где подсказка нужна.
  if (!t) return "С этой вкладки не пришло ни одного запроса — обнови страницу (F5).";
  if (t.taken > 0) return "";
  if (t.media > 0) {
    return (
      "Видео на этой странице идёт, но его плейлист был запрошен раньше, " +
      "чем включилось расширение. Обнови страницу (F5) и запусти видео заново."
    );
  }
  return "";
}

export async function readLog() {
  await ensureLoaded();
  return { entries: ring.slice().reverse(), samples: segmentSamples, counters };
}

export async function clearLog() {
  await ensureLoaded();
  ring = [];
  segmentSamples = [];
  counters = empty();
  await area.set({
    sightings: ring,
    sightSamples: segmentSamples,
    sightCounters: counters,
  });
}
