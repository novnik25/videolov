// Журнал перехвата и подсказка для пустого окна — на подставном хранилище.
//
// Проверяем главное различие, ради которого журнал и заведён: «на странице нет
// видео» и «видео идёт, но плейлист прошёл мимо» обязаны звучать по-разному.

const store = {};
globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        const out = {};
        for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    },
  },
};

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Путь считаем ОТ ЭТОГО ФАЙЛА: проект должен работать из любой папки на
// любом компьютере, а не из единственной, где его когда-то писали.
const LIB = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "lib") + path.sep,
).href;
const BASE = LIB;
const s = await import(BASE + "sightings.js");

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok   " : "ПЛОХО"} ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) bad++;
};

/* --- вкладка, где видео идёт, а плейлист прошёл мимо --- */
for (let i = 0; i < 40; i++) {
  await s.note(`https://cdn.ru/hls/seg-${i}.ts`, "xmlhttprequest", 7, "кусок потока", false, true);
}
const hint7 = await s.hintForTab(7);
check("про идущее видео подсказка есть", hint7.includes("Обнови страницу"), hint7 || "пусто");

/* --- вкладка, где видео нашлось: подсказка не нужна --- */
await s.note("https://cdn.ru/v/master.m3u8", "xmlhttprequest", 8, "hls", true);
check("при находке подсказки нет", (await s.hintForTab(8)) === "", await s.hintForTab(8));

/* --- вкладка, где вообще ничего не пришло --- */
const hint9 = await s.hintForTab(9);
check("про немую вкладку сказано отдельно", hint9.includes("ни одного запроса"), hint9 || "пусто");

/* --- обычная страница без видео: молчим, а не пугаем --- */
for (let i = 0; i < 5; i++) {
  await s.note(`https://site.ru/app-${i}.js`, "script", 10, "не видео", false);
}
check("на странице без видео подсказки нет", (await s.hintForTab(10)) === "", await s.hintForTab(10));

/* --- куски не забивают журнал, но считаются --- */
const log = await s.readLog();
check("счётчик кусков ведётся", log.counters.segments === 40, String(log.counters.segments));
check("в журнале кусков нет", log.entries.every((e) => e.verdict !== "кусок потока"));
check("примеры кусков сохранены", log.samples.length === 5, String(log.samples.length));
check(
  "журнал не раздувается",
  log.entries.length === 6,
  `${log.entries.length} строк: ${log.entries.map((e) => e.verdict).join(", ")}`,
);

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
