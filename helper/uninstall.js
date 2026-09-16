"use strict";
// Снятие помощника: чистим реестр и папку установки.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOST_NAME = "ru.videolov.helper";
const KEYS = [
  "HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts",
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
];

for (const key of KEYS) {
  try {
    execFileSync("reg", ["delete", `${key}\\${HOST_NAME}`, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(`убрано из реестра: ${key}\n`);
  } catch {
    /* ключа и не было */
  }
}

const dest = path.join(process.env.LOCALAPPDATA || os.homedir(), "Videolov");
try {
  fs.rmSync(dest, { recursive: true, force: true });
  process.stdout.write(`удалена папка: ${dest}\n`);
} catch (e) {
  process.stdout.write(`папку удалить не вышло: ${e.message}\n`);
}

process.stdout.write("Само расширение убирается на browser://extensions.\n");
