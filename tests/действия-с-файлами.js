// Проверка действий помощника над файлами. Удаление разрушительно — оно обязано
// бить ровно по указанному файлу и не падать на уже удалённом.
//
// Окна («Играть», «Папка», «Выбрать…») здесь не трогаем: они открывают
// проводник и плеер, такое проверяется только глазами.

const fs = require("fs");
const os = require("os");
const path = require("path");
const shell = require("../helper/lib/shell.js");

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok   " : "ПЛОХО"} ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) bad++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videolov-files-"));
const target = path.join(dir, "Урок 2. Проверка удаления.mp4");
const neighbour = path.join(dir, "Урок 3. Сосед.mp4");
fs.writeFileSync(target, "видео");
fs.writeFileSync(neighbour, "видео");

const res = shell.deleteFile(target);
check("удаление доложило об успехе", res.ok === true, JSON.stringify(res));
check("файл с русским именем удалён", !fs.existsSync(target));
check("соседний файл не тронут", fs.existsSync(neighbour));

const again = shell.deleteFile(target);
check("повторное удаление не падает", again.ok === true && again.already === true, JSON.stringify(again));

let threw = "";
try {
  shell.deleteFile("");
} catch (e) {
  threw = e.message;
}
check("пустой путь отвергнут внятно", threw.includes("не знаю"), threw || "исключения не было");

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
