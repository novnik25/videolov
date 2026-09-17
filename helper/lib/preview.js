"use strict";
// Кадр из середины ролика — обложка для списка.
//
// Обложка со страницы часто принадлежит не ролику, а разделу курса: один и тот
// же рисунок стоит у десятка уроков, и понять по нему, что именно скачиваешь,
// нельзя. Кадр из середины показывает сам урок.
//
// ⚠ Середину НЕ спрашиваем у ffprobe: на потоке HLS он раскручивает дорожку
// целиком и тратит больше минуты (замерено: 68 с). Длительность считает
// расширение — она записана в самом плейлисте. Сюда приходит готовая секунда.

const { spawn } = require("child_process");
const { tools } = require("./paths.js");

const TIMEOUT_MS = 45000;
const WIDTH = 320;

// Символы вне latin-1: HTTP-заголовки кодируются именно так, и любой символ
// за пределами таблицы валит запрос. Два выражения, а не одно с флагом g:
// выражение с g помнит позицию совпадения и в .test() через раз врёт.
const LATIN1_TEST = new RegExp("[^\\u0020-\\u00ff]");
const LATIN1_ALL = new RegExp("[^\\u0020-\\u00ff]", "g");

/**
 * Наборы ключей, которыми пробуем открыть поток, — от самого «понимающего»
 * к простому.
 *
 * ⚠ Потоковый плейлист далеко не всегда выглядит как плейлист. Встречается
 * адрес без расширения .m3u8, отданный с типом application/json, а куски в нём
 * названы 0.bin. Такой ffmpeg не открывает: сначала не понимает формат
 * (лечится «-f hls»), затем отказывается брать куски с незнакомым расширением
 * (лечится «-extension_picky 0»). Нужны ОБА ключа — установлено перебором.
 *
 * ⚠ Ключ -extension_picky есть не во всех сборках ffmpeg, а незнакомый ключ
 * ffmpeg считает ошибкой и не запускается вовсе. Поэтому наборы идут лесенкой:
 * не вышло с полным — пробуем короче. Так обложка работает и на чужой машине
 * со старой сборкой.
 */
const ATTEMPTS = [
  { name: "hls + любые куски", args: ["-f", "hls", "-extension_picky", "0"], hlsOnly: true },
  { name: "hls", args: ["-f", "hls"], hlsOnly: true },
  { name: "без подсказок", args: [], hlsOnly: false },
];

/** Заголовки для ffmpeg: одной строкой, через CRLF, как требует его http. */
function headerBlock(headers, cookies) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === "user-agent") continue; // у ffmpeg свой ключ
    const clean = latin1(v);
    if (clean) lines.push(`${k}: ${clean}`);
  }
  const jar = (cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
  if (jar) lines.push(`Cookie: ${jar}`);
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

function latin1(value) {
  const s = String(value == null ? "" : value);
  if (!LATIN1_TEST.test(s)) return s;
  if (/^https?:\/\//i.test(s)) {
    try {
      return encodeURI(s);
    } catch {
      /* чистим ниже */
    }
  }
  return s.replace(LATIN1_ALL, "");
}

function runOnce(job, attempt, done) {
  const t = tools();
  const seek = Math.max(0, Math.round(Number(job.seek) || 0));
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", ...attempt.args];

  const block = headerBlock(job.headers, job.cookies);
  if (block) args.push("-headers", block);
  const ua = latin1(job.headers?.["User-Agent"]);
  if (ua) args.push("-user_agent", ua);

  // -ss ДО -i: быстрый переход, ffmpeg скачивает только нужный кусок.
  args.push("-ss", String(seek), "-i", job.url);
  args.push("-frames:v", "1", "-vf", `scale=${WIDTH}:-2`, "-q:v", "6", "-f", "image2", "-");

  const child = spawn(t.ffmpeg, args, { windowsHide: true });
  const chunks = [];
  let err = "";
  let finished = false;

  const finish = (error, data) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(error, data);
  };

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже мёртв */
    }
    finish(new Error("кадр не успел вырезаться"));
  }, TIMEOUT_MS);

  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => (err += String(c).slice(0, 400)));
  child.on("error", (e) => finish(e));
  child.on("close", () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) {
      return finish(new Error(err.trim().split(/\r?\n/).pop() || "кадр не получился"));
    }
    finish(null, { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, bytes: buf.length });
  });
}

/**
 * Вынимает один кадр и отдаёт его как data-адрес.
 * @param {{url: string, seek: number, hls: boolean, headers: object, cookies: array}} job
 */
function grabFrame(job, done) {
  const t = tools();
  if (!t.ffmpeg) return done(new Error("ffmpeg не найден"));

  const plan = ATTEMPTS.filter((a) => !a.hlsOnly || job.hls);
  let last = null;

  const step = (i) => {
    if (i >= plan.length) return done(last || new Error("кадр не получился"));
    runOnce(job, plan[i], (err, data) => {
      if (!err) return done(null, data);
      last = err;
      process.stderr.write(`[видеолов] кадр (${plan[i].name}): ${err.message}\n`);
      step(i + 1);
    });
  };

  step(0);
}

module.exports = { grabFrame };
