"use strict";
// Сборка пакета для Chrome Web Store: node scripts/собрать-для-магазина.js
//
// Получается build/videolov-<версия>.zip — именно его загружают в магазин.
//
// ⚠ Из манифеста удаляется поле "key". Оно закрепляет идентификатор
// распакованного расширения, а опубликованному идентификатор выдаёт магазин;
// оставленный ключ вызывает отказ при загрузке пакета. После публикации
// впишите выданный идентификатор в helper/allowed-extensions.json и запустите
// установку загрузчика заново — иначе браузер не пустит расширение к нему.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "extension");
const BUILD = path.join(ROOT, "build");
const STAGE = path.join(BUILD, "extension");

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(a, b);
      continue;
    }
    // Вспомогательные файлы разработчика в пакет не кладём.
    if (entry.name.endsWith(".pem") || entry.name === "нарисовать-иконки.js") continue;
    fs.copyFileSync(a, b);
  }
}

function main() {
  fs.rmSync(BUILD, { recursive: true, force: true });
  copyTree(SRC, STAGE);

  const manifestPath = path.join(STAGE, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hadKey = Boolean(manifest.key);
  delete manifest.key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const zip = path.join(BUILD, `videolov-${manifest.version}.zip`);
  // Compress-Archive есть в любой Windows: стороннего упаковщика не требуется.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path "${STAGE}\\*" -DestinationPath "${zip}" -Force`,
    ],
    { stdio: "inherit", windowsHide: true },
  );

  const size = (fs.statSync(zip).size / 1024).toFixed(0);
  console.log("");
  console.log(`Пакет: ${zip} (${size} КБ)`);
  console.log(`Версия: ${manifest.version}`);
  console.log(`Поле key ${hadKey ? "удалено" : "отсутствовало"} — идентификатор выдаст магазин.`);
  console.log("");
  console.log("Дальше: docs/публикация-в-магазине.md");
}

main();
