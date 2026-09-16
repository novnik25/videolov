// Где хранить состояние, живущее один сеанс браузера.
//
// ⚠ chrome.storage.session есть не везде и не всегда работает: в части сборок
// на движке Chromium запись молча не доезжает. Для расширения это смертельно —
// найденное видео пишется в одну минуту, а читается в другую, уже другим
// (проснувшимся) служебным скриптом, и список всегда оказывается пуст.
// Поэтому область проверяется живьём: пишем метку, тут же читаем. Не сошлось —
// работаем в chrome.storage.local с приставкой, вычищая её при старте браузера.

const PREFIX = "sess:";

let area = null; // выбранная область
let usingFallback = false;
let probeResult = "не проверялась";
let probing = null;

async function probe() {
  const session = chrome.storage?.session;
  if (!session) {
    probeResult = "chrome.storage.session отсутствует";
    return false;
  }
  try {
    const mark = `${Date.now()}-${Math.random()}`;
    await session.set({ __probe: mark });
    const back = await session.get("__probe");
    await session.remove("__probe");
    if (back.__probe !== mark) {
      probeResult = "session не возвращает записанное";
      return false;
    }
    probeResult = "session работает";
    return true;
  } catch (e) {
    probeResult = `session бросает: ${String(e.message || e).slice(0, 120)}`;
    return false;
  }
}

async function ensure() {
  if (area) return;
  if (!probing) {
    probing = (async () => {
      const ok = await probe();
      if (ok) {
        area = chrome.storage.session;
        usingFallback = false;
        return;
      }
      area = chrome.storage.local;
      usingFallback = true;
      // Приставка живёт один сеанс: чистим её при первом обращении после старта
      // браузера. Признак старта — отсутствие метки сеанса.
      try {
        const got = await chrome.storage.local.get("__sessionMark");
        const mark = globalThis.__videolovBoot || (globalThis.__videolovBoot = Date.now());
        if (got.__sessionMark !== mark) {
          const all = await chrome.storage.local.get(null);
          const stale = Object.keys(all).filter((k) => k.startsWith(PREFIX));
          if (stale.length) await chrome.storage.local.remove(stale);
          await chrome.storage.local.set({ __sessionMark: mark });
        }
      } catch {
        /* чистка — не повод падать */
      }
    })();
  }
  await probing;
}

const key = (k) => (usingFallback ? PREFIX + k : k);

export async function get(keys) {
  await ensure();
  const list = [].concat(keys);
  const got = await area.get(list.map(key));
  const out = {};
  for (const k of list) {
    const stored = key(k);
    if (stored in got) out[k] = got[stored];
  }
  return out;
}

export async function set(obj) {
  await ensure();
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[key(k)] = v;
  await area.set(out);
}

export async function remove(keys) {
  await ensure();
  await area.remove([].concat(keys).map(key));
}

/** Для страницы разбора: какая область выбрана и почему. */
export async function describe() {
  await ensure();
  return { fallback: usingFallback, probe: probeResult };
}
