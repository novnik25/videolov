"use strict";
// Где что лежит: yt-dlp, ffmpeg и папка загрузок.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Куда смотреть вдобавок к PATH: WinGet кладёт ярлыки сюда. */
function extraDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [
    path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(os.homedir(), "scoop", "shims"),
    "C:\\ProgramData\\chocolatey\\bin",
    "C:\\ffmpeg\\bin",
  ];
}

/** Ищет программу в PATH, потом в известных местах. Возвращает путь или "". */
function findBinary(name) {
  try {
    const out = execFileSync("where", [name], { encoding: "utf8", windowsHide: true });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {
    /* не в PATH — ищем руками */
  }
  for (const dir of extraDirs()) {
    for (const ext of [".exe", ".cmd", ".bat", ""]) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* каталога может не быть */
      }
    }
  }
  return "";
}

/**
 * Настоящая папка «Загрузки».
 * ⚠ Просто homedir()\Downloads брать нельзя: папку переносят (у OneDrive это
 * обычное дело), и файлы уедут в каталог, которого человек не открывает.
 * Правду знает реестр — там лежит фактический путь.
 */
function downloadsDir() {
  const GUID = "{374DE290-123F-4565-9164-39C4925E467B}";
  try {
    const out = execFileSync(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
        "/v",
        GUID,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const m = out.match(/REG_[A-Z_]+\s+(.+)/);
    if (m) {
      const dir = m[1].trim();
      if (dir && fs.existsSync(dir)) return dir;
    }
  } catch {
    /* реестр недоступен — берём обычное место */
  }
  return path.join(os.homedir(), "Downloads");
}

let cache = null;

function tools() {
  if (cache) return cache;
  const ytdlp = findBinary("yt-dlp");
  const ffmpeg = findBinary("ffmpeg");
  cache = {
    ytdlp,
    ffmpeg,
    ffmpegDir: ffmpeg ? path.dirname(ffmpeg) : "",
    downloads: path.join(downloadsDir(), "Видеолов"),
  };
  return cache;
}

function versionOf(bin, args) {
  if (!bin) return "";
  try {
    const out = execFileSync(bin, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });
    return out.split(/\r?\n/)[0].trim().slice(0, 80);
  } catch {
    return "";
  }
}

module.exports = { tools, findBinary, downloadsDir, versionOf };
