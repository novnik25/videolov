// Страница разбора: показывает, на каком рубеже обрывается путь от запроса
// страницы до строки в списке. Приговор формулируется словами — читать журнал
// глазами не требуется.

const $ = (s) => document.querySelector(s);

function send(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ cmd, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("фоновый скрипт молчит"));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const time = (ms) => new Date(ms).toLocaleTimeString("ru-RU");

let snapshot = null;

/** Словами: что именно сломано. Это главная строка страницы. */
function verdictOf(log, tabs) {
  const c = log.counters;
  const withVideo = tabs.filter((t) => t.found > 0);

  if (c.seen === 0) {
    return {
      bad: true,
      title: "Перехват не работает",
      text:
        "Фоновый скрипт не увидел НИ ОДНОГО сетевого запроса. Значит дело не в " +
        "распознавании видео, а в самом расширении: оно отключено, у него забрали " +
        "доступ к сайтам, либо браузер не пускает его к трафику.",
    };
  }
  if (c.taken > 0 && withVideo.length > 0) {
    return {
      bad: false,
      title: "Видео найдено",
      text: `Расширение видит видео на ${withVideo.length} вкладке(ах). Если в окне пусто — открой окно на той вкладке, где играет урок.`,
    };
  }
  if (c.taken > 0) {
    return {
      bad: true,
      title: "Видео было найдено, но в списке его нет",
      text:
        "Запросы с видео распознаны и добавлены, а сейчас ни на одной вкладке их " +
        "нет. Либо вкладку с видео закрыли, либо страница перезагрузилась — список " +
        "привязан к вкладке и очищается при уходе с неё.",
    };
  }
  if (c.segments > 0) {
    return {
      bad: true,
      title: "Куски потока идут, а плейлист не пойман",
      text:
        `Перехвачено кусков потока: ${c.segments}. Само видео качается, но адрес ` +
        "его плейлиста расширение не узнало — либо плейлист запрошен до включения " +
        "расширения (тогда просто обнови страницу), либо он выглядит не как .m3u8.",
    };
  }
  return {
    bad: true,
    title: "Запросы идут, видео среди них нет",
    text:
      `Перехвачено запросов: ${c.seen}, все отброшены. Видео на этой странице либо ` +
      "ещё не запускалось, либо приходит в виде, которого разбор не знает — " +
      "смотри список ниже: там адреса и причины отказа.",
  };
}

function render(log, tabs) {
  const v = verdictOf(log, tabs);
  const box = $("#verdict");
  box.className = `verdict ${v.bad ? "bad" : "ok"}`;
  box.replaceChildren(el("b", null, v.title), el("p", null, v.text));

  const c = log.counters;
  $("#counters").replaceChildren(
    stat("всего запросов", c.seen),
    stat("признано видео", c.taken),
    stat("отброшено", c.dropped),
    stat("кусков потока", c.segments),
    stat("журнал с", time(c.startedAt)),
  );

  $("#samples").textContent = log.samples.length
    ? "примеры кусков: " + log.samples.slice(0, 3).join("   ")
    : "";

  const t = $("#tabs");
  t.replaceChildren();
  for (const tab of tabs) {
    if (!tab.url || tab.url.startsWith("chrome-extension://")) continue;
    t.append(el("div", null, `[находок: ${tab.found}]  ${tab.title}  —  ${tab.url.slice(0, 110)}`));
  }

  const logBox = $("#log");
  logBox.replaceChildren();
  if (!log.entries.length) {
    logBox.append(el("div", "hint", "пусто"));
    return;
  }
  for (const e of log.entries.slice(0, 120)) {
    const row = el("div", `entry ${e.taken ? "taken" : ""}`);
    row.append(el("span", "when", time(e.at)));
    row.append(el("span", "kind", e.taken ? "ВИДЕО" : e.verdict));
    row.append(el("span", "type", e.type));
    row.append(el("span", "url", e.url));
    logBox.append(row);
  }
}

function stat(name, value) {
  const n = el("div", "stat");
  n.append(el("b", null, String(value)), el("span", null, name));
  return n;
}

async function reload() {
  const [log, tabs] = await Promise.all([send("sightings"), send("tabs-overview")]);
  snapshot = { log, tabs: tabs.tabs };
  render(log, tabs.tabs);
}

function asText() {
  if (!snapshot) return "";
  const { log, tabs } = snapshot;
  const v = verdictOf(log, tabs);
  const lines = [
    "=== Видеолов: разбор ===",
    `приговор: ${v.title}`,
    `счётчики: всего ${log.counters.seen}, видео ${log.counters.taken}, ` +
      `отброшено ${log.counters.dropped}, кусков ${log.counters.segments}`,
    "",
    "--- вкладки ---",
    ...tabs
      .filter((t) => t.url && !t.url.startsWith("chrome-extension://"))
      .map((t) => `[${t.found}] ${t.url.slice(0, 160)}`),
    "",
    "--- примеры кусков потока ---",
    ...log.samples,
    "",
    "--- что видел перехватчик (свежее сверху) ---",
    ...log.entries.slice(0, 80).map((e) => `${e.taken ? "ВИДЕО" : e.verdict} | ${e.type} | ${e.url}`),
  ];
  return lines.join("\n");
}

$("#reload").addEventListener("click", () => void reload());
$("#reset").addEventListener("click", async () => {
  await send("clear-sightings");
  await reload();
});
$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(asText());
  const n = $("#copied");
  n.hidden = false;
  setTimeout(() => (n.hidden = true), 1600);
});

void reload();
