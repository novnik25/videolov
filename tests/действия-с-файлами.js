// Проверка действий помощника над файлами. Удаление разрушительно — оно обязано
// бить ровно по указанному файлу и не падать на уже удалённом.
//
// Окна («Играть», «Папка», «Выбрать…») здесь не трогаем: они открывают
// проводник и плеер, такое проверяется только глазами.

const fs = require("fs");
const os = require("os");
const path = require("path");
const shell = require("../helper/lib/shell.js");
const ytdlp = require("../helper/lib/ytdlp.js");

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

/* --- уборка обрывков прерванной загрузки --- */
// ⚠ При качке в 16 потоков каждый кусок пишется отдельным файлом
// «имя.mp4.part-Frag17». Убитый процесс склеить их не успевает, и папка
// зарастает обрывками с тем же именем, что и урок. Снимок от 16.09.2026.
const mess = fs.mkdtempSync(path.join(os.tmpdir(), "videolov-mess-"));
const base = "Урок 7. Юридическая сторона работы";
for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(mess, `${base}.mp4.part-Frag${i}`), "x");
fs.writeFileSync(path.join(mess, `${base}.mp4.part`), "x");
fs.writeFileSync(path.join(mess, `${base}.mp4.ytdl`), "x");
fs.writeFileSync(path.join(mess, `${base}.mp4`), "готовое видео");
fs.writeFileSync(path.join(mess, "Урок 6. Как уволить мастера.mp4"), "чужое видео");

const removed = ytdlp.cleanLeftovers(mess, base);
check("обрывки убраны все", removed === 27, String(removed));
const left = fs.readdirSync(mess).sort();
check("готовый файл урока цел", left.includes(`${base}.mp4`), left.join(" | "));
check("чужое видео не тронуто", left.includes("Урок 6. Как уволить мастера.mp4"));
check("в папке ровно два файла", left.length === 2, left.join(" | "));

// Разовая уборка при запуске трогает только СТАРОЕ: живую загрузку рушить нельзя.
const fresh = path.join(mess, "Идёт сейчас.mp4.part-Frag1");
fs.writeFileSync(fresh, "x");
const abandoned = path.join(mess, "Заброшено.mp4.part-Frag1");
fs.writeFileSync(abandoned, "x");
const longAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
fs.utimesSync(abandoned, longAgo, longAgo);

const swept = ytdlp.sweepStale(mess);
check("старый обрывок сметён", swept === 1 && !fs.existsSync(abandoned), String(swept));
check("свежий обрывок оставлен", fs.existsSync(fresh));

fs.rmSync(mess, { recursive: true, force: true });

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
