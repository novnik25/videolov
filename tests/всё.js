// Все проверки разом: node tests/всё.js
//
// Порядок не случаен — сначала дешёвые и быстрые, потом те, что поднимают
// браузер и тянут сеть. Падение быстрой проверки экономит минуты.

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const SUITES = [
  ["распознавание", "node", ["tests/распознавание.mjs"]],
  ["подсказки", "node", ["tests/подсказки.mjs"]],
  ["хранилище", "node", ["tests/хранилище.mjs"]],
  ["сборка", "node", ["tests/сборка.mjs"]],
  ["заголовки", "node", ["tests/заголовки.js"]],
  ["действия с файлами", "node", ["tests/действия-с-файлами.js"]],
  ["связь с помощником", "node", ["tests/связь-с-помощником.js"]],
  ["установленный помощник", "node", ["tests/установленный-помощник.js"]],
  ["плейлист без расширения", "python", ["tests/плейлист-без-расширения.py"]],
  ["живая проверка", "python", ["tests/живая-проверка.py"]],
];

// ⚠ Прокси учётной записи наследуется и безголовым браузером, и ffmpeg —
// с ним сеть в проверках дохнет. Снимаем его на время прогона.
const env = { ...process.env };
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
delete env.http_proxy;
delete env.https_proxy;

const failed = [];
const started = Date.now();

for (const [name, cmd, args] of SUITES) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const t0 = Date.now();
  // Без shell: node и python — обычные .exe, оболочка тут не нужна, а с ней
  // Node ругается на неэкранированные аргументы.
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const tail = out.trim().split(/\r?\n/).slice(-3).join("\n");
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    process.stdout.write(`${tail}\n(${sec} с)\n`);
  } else {
    failed.push(name);
    process.stdout.write(`${out.trim().split(/\r?\n/).filter((l) => l.includes("ПЛОХО")).join("\n")}\n`);
    process.stdout.write(`ПРОВАЛ (${sec} с)\n`);
  }
}

const total = ((Date.now() - started) / 60000).toFixed(1);
process.stdout.write(`\n${"=".repeat(50)}\n`);
if (failed.length) {
  process.stdout.write(`ПРОВАЛИЛИСЬ: ${failed.join(", ")}  (всего ${total} мин)\n`);
  process.exit(1);
}
process.stdout.write(`Все ${SUITES.length} наборов прошли (${total} мин)\n`);
