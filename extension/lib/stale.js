// Проверка «начинка устарела» — и перезапуск расширения изнутри.
//
// ⚠ В Яндекс.Браузере на странице расширений НЕТ кнопки «Обновить» (в Chrome
// она есть). Без неё правка кода служебного скрипта не вступает в силу до
// перезапуска всего браузера, а выглядит это как «исправление не помогло».
// Страницы расширения при этом читаются с диска заново при каждом открытии —
// значит свежая страница может обнаружить старую начинку и перезапустить её
// сама. Ровно это здесь и делается.

import { BUILD } from "./build.js";

function ask(cmd) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ cmd }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Сверяет отметку сборки страницы с отметкой служебного скрипта.
 * @returns {Promise<{stale: boolean, running: string}>}
 */
export async function checkStale() {
  const res = await ask("build");
  // Команды нет или ответа нет — значит начинка старше этой страницы.
  if (!res || !res.ok || !res.data?.build) return { stale: true, running: "неизвестна" };
  return { stale: res.data.build !== BUILD, running: res.data.build };
}

/** Перезапускает расширение. Страница после этого умирает — это нормально. */
export function restart() {
  chrome.runtime.reload();
}

export { BUILD };
