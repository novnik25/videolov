"use strict";
// Кадр из СЕРЕДИНЫ ролика — обложка для списка.
//
// ⚠ Обложка со страницы не годится: у курсов там нарисован модуль целиком
// («Модуль 3»), один и тот же рисунок на десяток уроков — по нему невозможно
// понять, какой урок скачиваешь. Кадр из середины показывает сам урок.
//
// ⚠ Середину НЕ спрашиваем у ffprobe: на потоке HLS он честно раскручивает
// дорожку и тратит больше минуты (замерено 17.09.2026: 68 с). Длительность
// считает расширение — она лежит прямо в плейлисте, суммой #EXTINF. Сюда
// приходит уже готовая секунда.

const { spawn } = require("child_process");
const { tools } = require("./paths.js");

const TIMEOUT_MS = 45000;
const WIDTH = 320;

/** Заголовки для ffmpeg: одной строкой, через CRLF, как требует его http. */
function headerBlock(headers, cookies) {
  const lines = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() === "user-agent") continue; // у ffmpeg свой ключ
    const clean = latin1(v);
    if (clean) lines.push(`${k}: ${clean}`);
  }
  const jar = (cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (jar) lines.push(`Cookie: ${jar}`);
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

/** Та же беда, что у yt-dlp: символы вне latin-1 ломают заголовок. */
function latin1(value) {
  const s = String(value == null ? "" : value);
  if (!/[^ -ÿ]/.test(s)) return s;
  if (/^https?:\/\//i.test(s)) {
    try {
      return encodeURI(s);
    } catch {
      /* чистим ниже */
    }
  }
  return s.replace(/[^ -ÿ]/g, "");
}

/**
 * Вынимает один кадр и отдаёт его как data-адрес.
 * @param {{url: string, seek: number, headers: object, cookies: array}} job
 */
function grabFrame(job, done) {
  const t = tools();
  if (!t.ffmpeg) return done(new Error("ffmpeg не найден"));

  const seek = Math.max(0, Math.round(Number(job.seek) || 0));
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];

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

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* уже мёртв */
    }
    done(new Error("кадр не успел вырезаться"));
  }, TIMEOUT_MS);

  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => (err += String(c).slice(0, 400)));
  child.on("error", (e) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(e);
  });
  child.on("close", () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const buf = Buffer.concat(chunks);
    if (!buf.length) {
      return done(new Error(err.trim().split(/\r?\n/).pop() || "кадр не получился"));
    }
    done(null, { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, bytes: buf.length });
  });
}

module.exports = { grabFrame };
