// Приведение заголовков к latin-1 — то, без чего загрузка падает с
// невнятным UnicodeEncodeError, ни словом не упоминая заголовки.

const { latin1Header, safeBaseName } = require("../helper/lib/ytdlp.js");

let bad = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok   " : "ПЛОХО"} ${name}${ok ? "" : "  — " + detail}`);
  if (!ok) bad++;
};

/* --- адрес с кириллицей переводится в проценты, а не режется --- */
const ru = "https://разработчик.рф/курс/урок 1";
const encoded = latin1Header(ru);
check("кириллица в адресе закодирована", encoded.includes("%D1%80"), encoded);
check("адрес остался адресом", encoded.startsWith("https://"), encoded);
check("в ответе нет ничего вне latin-1", !/[^ -ÿ]/.test(encoded), encoded);

/* --- обычный заголовок не трогаем --- */
const plain = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
check("латиница проходит как есть", latin1Header(plain) === plain, latin1Header(plain));

/* --- НЕ адрес: чистим --- */
const mixed = "Курс Никиты v2";
// Пробелы между словами остаются — вычищаются только сами буквы.
check("текст очищен от кириллицы", latin1Header(mixed) === "  v2", JSON.stringify(latin1Header(mixed)));

/* --- устойчивость: тот же вход обязан давать тот же ответ --- */
// ⚠ Здесь пряталась настоящая беда. Выражение с флагом g ПОМНИТ позицию
// последнего совпадения, и .test() на нём через раз возвращает ложь для одной
// и той же строки: «Lesson 7 — part» → true, false, true. Заголовок уходил бы
// неочищенным ЧЕРЕЗ РАЗ, а загрузка падала бы через одну. Поймано 17.09.2026.
const oneOutside = "Lesson 7 — part";
const answers = [latin1Header(oneOutside), latin1Header(oneOutside), latin1Header(oneOutside)];
check("ответ не зависит от числа вызовов", new Set(answers).size === 1, answers.join(" | "));
check("тире вычищено", !/[^ -ÿ]/.test(answers[0]), JSON.stringify(answers[0]));

/* --- имя файла: одно правило на весь помощник --- */
const dirty = "Урок 7: Юридическая" + String.fromCharCode(92) + "сторона? <работы>|100%";
const clean = safeBaseName(dirty);
check("запрещённые символы убраны", !/[\\/:*?"<>|%]/.test(clean), clean);
check("название читается", clean.startsWith("Урок 7"), clean);
check("пустое имя заменяется", safeBaseName("   ") === "video", safeBaseName("   "));

console.log(bad ? `\nПРОВАЛОВ: ${bad}` : "\nвсё сошлось");
process.exit(bad ? 1 : 0);
