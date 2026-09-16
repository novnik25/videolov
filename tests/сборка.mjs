// Определение «начинка устарела».
//
// ⚠ В Яндекс.Браузере нет кнопки «Обновить» для распакованного расширения:
// правка кода служебного скрипта не вступает в силу, пока расширение не
// перезапустят. Снаружи это неотличимо от «исправление не помогло», поэтому
// расхождение должно ловиться само. Проверяем ВСЕ способы, которыми старая
// начинка себя выдаёт: другая отметка, отказ отвечать, незнакомая команда.

const BASE = "file:///C:/Users/novos/OneDrive/Документы/Claude/Projects/Видеолов/extension/lib/";

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok   " : "ПЛОХО"} ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) bad++;
};

const { BUILD } = await import(BASE + "build.js");

let seq = 0;
async function withAnswer(answer, lastError = null) {
  globalThis.chrome = {
    runtime: {
      lastError,
      sendMessage(_msg, cb) {
        cb(answer);
      },
      reload() {
        globalThis.__reloaded = true;
      },
    },
  };
  return import(`${BASE}stale.js?v=${++seq}`);
}

/* Служебный скрипт той же сборки — всё в порядке. */
{
  const s = await withAnswer({ ok: true, data: { build: BUILD } });
  const r = await s.checkStale();
  check("совпадающая сборка не тревожит", r.stale === false, JSON.stringify(r));
  check("отметка запущенной начинки видна", r.running === BUILD, r.running);
}

/* Другая сборка — начинка старая. */
{
  const s = await withAnswer({ ok: true, data: { build: "2020-01-01-01" } });
  const r = await s.checkStale();
  check("расхождение замечено", r.stale === true, JSON.stringify(r));
  check("показано, что именно работает", r.running === "2020-01-01-01", r.running);
}

/* Команды нет — так отвечает начинка, выпущенная до появления отметки. */
{
  const s = await withAnswer({ ok: false, error: "неизвестная команда: build" });
  const r = await s.checkStale();
  check("незнакомая команда считается старой начинкой", r.stale === true, JSON.stringify(r));
}

/* Ответа нет вовсе. */
{
  const s = await withAnswer(undefined);
  check("молчание считается старой начинкой", (await s.checkStale()).stale === true);
}

/* Связь оборвалась — lastError. */
{
  const s = await withAnswer(null, { message: "порт закрыт" });
  const r = await s.checkStale();
  check("обрыв связи считается старой начинкой", r.stale === true, JSON.stringify(r));
  check("начинка названа неизвестной", r.running === "неизвестна", r.running);
}

/* Перезапуск действительно зовёт браузер. */
{
  const s = await withAnswer({ ok: true, data: { build: BUILD } });
  globalThis.__reloaded = false;
  s.restart();
  check("перезапуск дёргает chrome.runtime.reload", globalThis.__reloaded === true);
}

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
