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

const FILES = [
  "host.js",
  path.join("lib", "paths.js"),
  path.join("lib", "ytdlp.js"),
  path.join("lib", "cookies.js"),
  path.join("lib", "shell.js"),
];

function main() {
  const src = __dirname;
  const dest = path.join(process.env.LOCALAPPDATA || os.homedir(), "Videolov");

  say("Видеолов — установка помощника");
  say(`  откуда: ${src}`);
  say(`  куда:   ${dest}`);

  fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
  for (const rel of FILES) {
    fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
  }
  say(`  скопировано файлов: ${FILES.length}`);

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

function say(s) {
  process.stdout.write(s + "\n");
}

main();
