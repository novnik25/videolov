"use strict";
// Установка помощника: копирование в постоянное место + запись в реестр.
//
// Почему копируем, а не регистрируем папку проекта: проект лежит в OneDrive, а
// там файл может оказаться «только в облаке» — браузер получит отказ и объявит
// помощника отсутствующим. Постоянное место — %LOCALAPPDATA%\Videolov.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOST_NAME = "ru.videolov.helper";
const EXT_ID = "bddbplfelcdknmmmbidbeecominenlcg";

// Ветки реестра браузеров на движке Chromium. Пишем во все: какой запущен,
// такой и подхватит. Лишние ключи никому не мешают.
const BROWSER_KEYS = [
  ["Яндекс.Браузер", "HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts"],
  ["Chrome", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts"],
  ["Chromium", "HKCU\\Software\\Chromium\\NativeMessagingHosts"],
  ["Edge", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts"],
];

/**
 * Что копировать.
 * ⚠ Раньше здесь был список файлов вручную — и новый модуль в него забыли
 * добавить: помощник установился, но падал на первом же запуске с «Cannot find
 * module». Браузер показывал «помощник не отвечает», хотя дело было в
 * установщике. Теперь берём папку lib целиком: забыть нечего.
 */
function filesToCopy(src) {
  const lib = fs
    .readdirSync(path.join(src, "lib"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("lib", f));
  return ["host.js", ...lib];
}

function main() {
  const src = __dirname;
  const dest = path.join(process.env.LOCALAPPDATA || os.homedir(), "Videolov");

  say("Видеолов — установка помощника");
  say(`  откуда: ${src}`);
  say(`  куда:   ${dest}`);

  fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
  const files = filesToCopy(src);
  for (const rel of files) {
    fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
  }
  say(`  скопировано файлов: ${files.length} (${files.join(", ")})`);

  // Запускалка. Браузер умеет запускать только .exe/.bat, поэтому путь к node
  // зашиваем прямо сюда — PATH у запущенного браузером процесса бывает урезан.
  const bat = path.join(dest, "videolov-helper.bat");
  fs.writeFileSync(
    bat,
    ["@echo off", `"${process.execPath}" "%~dp0host.js" %*`, ""].join("\r\n"),
    "utf8",
  );
  say(`  запускалка: ${bat}`);

  // Манифест помощника: кому разрешено к нему обращаться.
  const manifest = path.join(dest, `${HOST_NAME}.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: "Видеолов — загрузка видео через yt-dlp",
        path: bat,
        type: "stdio",
        allowed_origins: [`chrome-extension://${EXT_ID}/`],
      },
      null,
      2,
    ),
    "utf8",
  );
  say(`  манифест:   ${manifest}`);

  let written = 0;
  for (const [title, key] of BROWSER_KEYS) {
    try {
      execFileSync("reg", ["add", `${key}\\${HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      say(`  реестр: ${title} — записано`);
      written++;
    } catch (e) {
      say(`  реестр: ${title} — не вышло (${e.message.split("\n")[0]})`);
    }
  }

  if (!written) {
    say("");
    say("НИ ОДНА ветка реестра не записалась. Помощник работать не будет.");
    process.exitCode = 1;
    return;
  }

  // Сверка: читаем то, что записали. Путь содержит кириллицу, и молча
  // испортиться он может именно здесь.
  verify();
  // И главное — ЗАПУСКАЕМ установленного помощника. Установка, которая не
  // проверила работоспособность, врёт: файлы на месте, а модуля не хватает.
  verifyRuns(dest);

  say("");
  say("Готово. Дальше — один раз поставить само расширение:");
  say("  1. Яндекс.Браузер → browser://extensions");
  say("  2. Включить «Режим разработчика» (переключатель справа сверху)");
  say("  3. «Загрузить распакованное расширение» → выбрать папку extension");
  say("");
  say("Если браузер был открыт — перезапусти его, иначе помощника он не увидит.");
}

function verify() {
  const key = `${BROWSER_KEYS[0][1]}\\${HOST_NAME}`;
  try {
    const out = execFileSync("reg", ["query", key, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const m = out.match(/REG_SZ\s+(.+)/);
    const got = m ? m[1].trim() : "";
    if (got && fs.existsSync(got)) say(`  сверка: манифест на месте (${got})`);
    else say(`  сверка: ПУТЬ НЕ ОТКРЫВАЕТСЯ — ${got || "пусто"}`);
  } catch (e) {
    say(`  сверка: не прочитался ключ (${e.message.split("\n")[0]})`);
  }
}

/**
 * Поднять установленного помощника и спросить его о самочувствии.
 * Кадр протокола — те же 4 байта длины и JSON, что шлёт браузер.
 */
function verifyRuns(dest) {
  const { spawnSync } = require("child_process");
  const body = Buffer.from(JSON.stringify({ t: "req", id: 1, cmd: "ping", args: {} }), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);

  const r = spawnSync(process.execPath, [path.join(dest, "host.js")], {
    input: Buffer.concat([head, body]),
    timeout: 30000,
    windowsHide: true,
  });
  const out = r.stdout || Buffer.alloc(0);
  if (out.length > 4) {
    try {
      const answer = JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString("utf8"));
      if (answer?.ok) {
        const d = answer.data || {};
        say(`  запуск: помощник отвечает (yt-dlp ${d.ytdlpVersion || "?"}, ffmpeg ${d.ffmpegVersion || "?"})`);
        return;
      }
    } catch {
      /* ниже скажем, что ответ невнятный */
    }
  }
  const err = String(r.stderr || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  say(`  ЗАПУСК НЕ УДАЛСЯ: ${err || "помощник промолчал"}`);
  process.exitCode = 1;
}

function say(s) {
  process.stdout.write(s + "\n");
}

main();
