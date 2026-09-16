"use strict";
// Куки из браузера — в файл формата Netscape, который понимает yt-dlp.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

/**
 * ⚠ Сессионной куке нельзя писать срок 0.
 * Формат Netscape хранит срок числом, и питоновский разбор внутри yt-dlp читает
 * ноль как «истекла 1 января 1970-го» — кука молча выбрасывается, а закрытый
 * курс отвечает 403. Ровно такие куки чаще всего и держат авторизацию, поэтому
 * им проставляется завтрашний день: файл живёт минуты, дольше и не нужно.
 */
const SESSION_TTL_SEC = 24 * 60 * 60;

function line(c) {
  const includeSub = c.domain.startsWith(".") ? "TRUE" : "FALSE";
  const expires = c.expires && c.expires > 0
    ? Math.round(c.expires)
    : Math.round(Date.now() / 1000) + SESSION_TTL_SEC;
  return [
    c.domain,
    includeSub,
    c.path || "/",
    c.secure ? "TRUE" : "FALSE",
    String(expires),
    c.name,
    c.value,
  ].join("\t");
}

/** Пишет временный файл кук и возвращает путь. Пустой список — пустой путь. */
function writeCookieFile(cookies) {
  const list = (cookies || []).filter((c) => c && c.name && c.domain);
  if (!list.length) return "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videolov-"));
  const file = path.join(dir, `c-${crypto.randomBytes(4).toString("hex")}.txt`);
  const body = [
    "# Netscape HTTP Cookie File",
    "# Создано Видеоловом, живёт до конца загрузки.",
    ...list.map(line),
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** Убирает файл кук вместе с его временной папкой. */
function dropCookieFile(file) {
  if (!file) return;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* уже убрано */
  }
}

module.exports = { writeCookieFile, dropCookieFile };
