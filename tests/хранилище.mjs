// Выбор области хранения: area.js обязан ПРОВЕРИТЬ session живой записью,
// а не поверить в её существование.
//
// Ради этого всё и затевалось: в сборке, где session молча не сохраняет,
// список найденного всегда читается пустым — и выглядит это как «расширение
// ничего не находит».

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Путь считаем ОТ ЭТОГО ФАЙЛА: проект должен работать из любой папки на
// любом компьютере, а не из единственной, где его когда-то писали.
const LIB = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "lib") + path.sep,
).href;
const BASE = LIB;

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok   " : "ПЛОХО"} ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) bad++;
};

/** Обычная рабочая область памяти. */
function makeArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys === null ? Object.keys(data) : keys)) {
        if (k in data) out[k] = data[k];
      }
      return out;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

let seq = 0;
async function freshArea(session, local) {
  globalThis.chrome = { storage: { session, local } };
  delete globalThis.__videolovBoot;
  return import(`${BASE}area.js?v=${++seq}`); // модуль кеширует выбор — берём новый
}

/* 1. Здоровая session — работаем в ней. */
{
  const session = makeArea();
  const local = makeArea();
  const a = await freshArea(session, local);
  await a.set({ "found:5": [1, 2, 3] });
  const got = await a.get("found:5");
  const d = await a.describe();
  check("здоровая session выбрана", d.fallback === false, JSON.stringify(d));
  check("значение читается обратно", JSON.stringify(got["found:5"]) === "[1,2,3]");
  check("писали именно в session", "found:5" in session.data, Object.keys(session.data).join());
}

/* 2. session отсутствует — уходим в local. */
{
  const local = makeArea();
  const a = await freshArea(undefined, local);
  await a.set({ "found:7": ["видео"] });
  const got = await a.get("found:7");
  const d = await a.describe();
  check("без session берётся local", d.fallback === true, JSON.stringify(d));
  check("значение всё равно читается", got["found:7"][0] === "видео");
  check("ключ помечен приставкой", "sess:found:7" in local.data, Object.keys(local.data).join());
}

/* 3. session ЛЖЁТ: запись принимает, а обратно не отдаёт. Это и есть тот
      случай, который снаружи выглядит как «ничего не находится». */
{
  const local = makeArea();
  const liar = {
    async get() {
      return {};
    },
    async set() {},
    async remove() {},
  };
  const a = await freshArea(liar, local);
  await a.set({ "found:9": ["урок"] });
  const got = await a.get("found:9");
  const d = await a.describe();
  check("лживая session разоблачена", d.fallback === true, d.probe);
  check("причина названа словами", d.probe.includes("не возвращает"), d.probe);
  check("данные не потерялись", got["found:9"][0] === "урок");
}

/* 4. session бросает исключение — тоже уходим в local, а не падаем. */
{
  const local = makeArea();
  const thrower = {
    async get() {
      throw new Error("нет доступа");
    },
    async set() {
      throw new Error("нет доступа");
    },
    async remove() {},
  };
  const a = await freshArea(thrower, local);
  await a.set({ "found:11": ["урок"] });
  check("падающая session не роняет расширение", (await a.get("found:11"))["found:11"][0] === "урок");
  check("причина падения записана", (await a.describe()).probe.includes("бросает"));
}

/* 5. Старый сеанс вычищается: приставка живёт один запуск браузера. */
{
  const local = makeArea();
  local.data["sess:found:1"] = ["прошлый сеанс"];
  local.data["settings"] = { folder: "D:/видео" };
  const a = await freshArea(undefined, local);
  await a.get("found:1");
  check("мусор прошлого сеанса убран", !("sess:found:1" in local.data), Object.keys(local.data).join());
  check("настройки не тронуты", local.data.settings.folder === "D:/видео");
}

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
