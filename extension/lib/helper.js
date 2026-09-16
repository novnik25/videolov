// Связь с помощником на компьютере (native messaging).
//
// Браузер сам запускает помощника при первом обращении и гасит, когда порт
// закрывается. Никакого висящего процесса и открытого порта: список разрешённых
// расширений зашит в манифест помощника, чужой сайт достучаться не может.

const HOST = "ru.videolov.helper";

let port = null;
let seq = 0;
const waiting = new Map(); // id запроса → {resolve, reject}
const listeners = new Set(); // подписчики на события загрузок

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(msg) {
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch (e) {
      console.error("[видеолов] подписчик упал", e);
    }
  }
}

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "res") {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      msg.ok ? w.resolve(msg.data) : w.reject(new Error(msg.error || "помощник вернул ошибку"));
      return;
    }
    if (msg.t === "event") emit(msg);
  });

  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message || "соединение закрыто";
    port = null;
    for (const [, w] of waiting) w.reject(new Error(why));
    waiting.clear();
    emit({ t: "event", kind: "disconnected", error: why });
  });

  return port;
}

/** Запрос-ответ. Бросает, если помощник не установлен или ответил ошибкой. */
export function call(cmd, args = {}, timeoutMs = 120000) {
  const id = ++seq;
  const p = connect();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiting.delete(id)) reject(new Error("помощник молчит дольше положенного"));
    }, timeoutMs);
    waiting.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      p.postMessage({ t: "req", id, cmd, args });
    } catch (e) {
      waiting.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** Жив ли помощник и на месте ли yt-dlp с ffmpeg. */
export async function health() {
  try {
    const data = await call("ping", {}, 15000);
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function isConnected() {
  return Boolean(port);
}
