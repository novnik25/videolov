// Окно расширения: список найденного, выбор качества, ход загрузок, история.

import { checkStale, restart } from "./lib/stale.js";

const $ = (sel) => document.querySelector(sel);

let tabId = null;
let state = { found: [], jobs: {}, history: [], settings: {} };
const probes = new Map(); // id находки → список качеств (чтобы не спрашивать дважды)
const opened = new Set(); // какие карточки раскрыты
const modes = new Map(); // id находки → выбранный режим
const names = new Map(); // id находки → имя, которое правит человек
const painted = new Set(); // что уже показывали: повторно не анимируем
const posters = new Map(); // id находки → кадр из середины ролика
const asked = new Set(); // у кого кадр уже заказан — чтобы не просить дважды

/* --------------------------------------------------------------- значки */

// Рисунки из набора Lucide: одна толщина линии, одинаковые скругления.
// Не эмодзи: те зависят от системного шрифта и не подчиняются цвету темы.
const PATHS = {
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  chevron: "M6 9l6 6 6-6",
  play: "M5 3l14 9-14 9z",
  folder: "M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z",
  trash: "M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  x: "M18 6L6 18 M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  alert: "M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  pause: "M6 4h4v16H6z M14 4h4v16h-4z",
};

function icon(name, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  for (const d of PATHS[name].split(" M")) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d.startsWith("M") ? d : "M" + d);
    svg.append(p);
  }
  return svg;
}

/* ------------------------------------------------------------- обёртки */

function send(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ cmd, tabId, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error("фоновый скрипт молчит"));
      res.ok ? resolve(res.data) : reject(new Error(res.error));
    });
  });
}

const fmtSize = (b) => {
  if (!b) return "";
  const u = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtSpeed = (bps) => (bps ? `${fmtSize(bps)}/с` : "");

const fmtEta = (s) => {
  if (!s || s < 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m ? `${m} мин ${sec} с` : `${sec} с`;
};

/**
 * Обложка урока. Если её нет — рисуем заглушку того же размера: без неё
 * карточки прыгают по ширине, а список выглядит рваным.
 */
function thumb(src, label) {
  const box = el("div", "thumb");
  if (src) {
    const img = el("img");
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    // Битая ссылка на превью не должна оставлять дыру.
    img.addEventListener("error", () => {
      img.remove();
      box.append(el("span", "thumb-tag", label));
    });
    box.append(img);
  } else {
    box.append(el("span", "thumb-tag", label));
  }
  return box;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* -------------------------------------------------------- состояние */

async function refresh() {
  state = await send("state");
  render();
}

let pending = false;
function scheduleRefresh() {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    refresh().catch(() => {});
  }, 250);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.cmd === "state-changed") scheduleRefresh();
});

/* ------------------------------------------------------------ отрисовка */

/**
 * Перерисовка.
 * ⚠ Во время загрузки состояние обновляется каждые 250 мс, и полная замена
 * содержимого выбрасывала бы поле с недописанным именем вместе с курсором.
 * Поэтому набранное хранится отдельно (names), а фокус и положение курсора
 * возвращаются на место после отрисовки.
 */
function render() {
  const active = document.activeElement;
  const key = active?.dataset?.nameFor || null;
  const caret = key ? [active.selectionStart, active.selectionEnd] : null;

  renderFound();
  renderDownloads();

  if (!key) return;
  const next = document.querySelector(`input[data-name-for="${CSS.escape(key)}"]`);
  if (!next) return;
  next.focus();
  try {
    next.setSelectionRange(caret[0], caret[1]);
  } catch {
    /* поле могло смениться — курсор встанет в конец */
  }
}

/** Каскад появления: каждая следующая карточка на 40 мс позже предыдущей. */
function stagger(node, key, index) {
  if (painted.has(key)) {
    node.style.animation = "none";
    return;
  }
  painted.add(key);
  node.style.animationDelay = `${Math.min(index, 6) * 40}ms`;
}

function renderFound() {
  const box = $("#found");
  box.replaceChildren();
  const count = $("#found-count");
  count.textContent = String(state.found.length);
  count.hidden = state.found.length === 0;
  $("#empty").hidden = state.found.length > 0;

  // Пустому окну — объяснение, а не молчание.
  const hintBox = $("#empty-hint");
  hintBox.textContent = state.hint || "";
  hintBox.hidden = !state.hint;

  state.found.forEach((item, i) => box.append(foundCard(item, i)));
}

/**
 * Кадр из середины ролика — заказываем лениво, по одному.
 * ⚠ Картинка со страницы для курсов бесполезна: там нарисован модуль целиком,
 * одна и та же на десяток уроков. Поэтому для потоков берём НЕ её, а кадр.
 * Для известных площадок (ютуб и прочие) страничная обложка как раз верная —
 * там она принадлежит конкретному ролику.
 */
function posterFor(item) {
  if (item.kind === "page") return item.poster || "";
  // ⚠ Кадр — предпочтительнее, но если вырезать его не вышло, показываем
  // обложку страницы. Пустая рамка не лучше неточной картинки.
  return posters.get(item.id) || item.poster || "";
}

function ensurePoster(item) {
  if (item.kind === "page" || posters.has(item.id) || asked.has(item.id)) return;
  asked.add(item.id);
  send("preview", { itemId: item.id })
    .then((d) => {
      if (!d?.dataUrl) return;
      posters.set(item.id, d.dataUrl);
      render();
    })
    .catch(() => {
      /* кадра не будет — останется метка формата */
    });
}

function foundCard(item, index) {
  const card = el("div", "card");
  stagger(card, `f:${item.id}`, index);
  ensurePoster(item);

  const head = el("div", "card-head");
  head.append(thumb(posterFor(item), item.label));
  const titleBox = el("div", "title");
  titleBox.append(el("div", null, item.name || item.title || "без названия"));
  titleBox.append(el("div", "sub", shortUrl(item.url)));
  head.append(titleBox);
  card.append(head);

  const isOpen = opened.has(item.id);

  const toggle = el("button", "ghost");
  toggle.setAttribute("aria-expanded", String(isOpen));
  // Раскрытая карточка уже показывает главную кнопку «Скачать» — вторая такая
  // же рядом только путает, поэтому подпись меняется.
  toggle.append(
    icon("download"),
    el("span", null, isOpen ? "Свернуть" : "Скачать"),
    icon("chevron", "chev"),
  );
  toggle.addEventListener("click", () => {
    isOpen ? opened.delete(item.id) : opened.add(item.id);
    render();
    if (!isOpen) void loadFormats(item);
  });

  const headRow = el("div", "row");
  headRow.append(toggle);
  card.append(headRow);

  if (!isOpen) return card;

  /* --- раскрытая панель --- */

  const nameRow = el("div", "row");
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.value = names.has(item.id) ? names.get(item.id) : item.name || "";
  nameInput.dataset.nameFor = item.id;
  nameInput.setAttribute("aria-label", "Имя файла");
  nameInput.title = "Имя файла — можно поправить до старта";
  nameInput.addEventListener("input", () => names.set(item.id, nameInput.value));
  nameRow.append(nameInput);
  card.append(nameRow);

  const optRow = el("div", "row");

  // Режим: все три варианта на виду, выбранный подсвечен.
  const mode = modes.get(item.id) || "av";
  const seg = el("div", "seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Что скачивать");
  const qualSel = el("select");
  for (const [v, t, hint] of [
    ["av", "Видео", "видео со звуком"],
    ["a", "Звук", "только звуковая дорожка"],
    ["v", "Без звука", "только видео, без звука"],
  ]) {
    const b = el("button", null, t);
    b.type = "button";
    b.title = hint;
    b.setAttribute("aria-pressed", String(mode === v));
    b.addEventListener("click", () => {
      modes.set(item.id, v);
      for (const other of seg.children) other.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-pressed", "true");
      // Звук перекодируется целиком — выбирать разрешение там нечего.
      qualSel.disabled = v === "a" || !probes.get(item.id);
    });
    seg.append(b);
  }

  qualSel.setAttribute("aria-label", "Качество");
  const cached = probes.get(item.id);
  if (!cached) {
    const o = el("option", null, "качества…");
    o.value = "";
    qualSel.append(o);
    qualSel.disabled = true;
  } else if (cached.error) {
    const o = el("option", null, "лучшее доступное");
    o.value = "";
    qualSel.append(o);
  } else {
    for (const f of cached.formats) {
      const o = el("option", null, f.label);
      o.value = JSON.stringify({ id: f.id || "", height: f.height || 0 });
      qualSel.append(o);
    }
  }
  if (mode === "a") qualSel.disabled = true;

  const go = el("button", "go", "Скачать");
  go.addEventListener("click", async () => {
    go.disabled = true;
    go.textContent = "…";
    let pick = { id: "", height: 0 };
    try {
      pick = JSON.parse(qualSel.value || "{}");
    } catch {
      /* «лучшее доступное» */
    }
    try {
      await send("download", {
        itemId: item.id,
        name: nameInput.value.trim() || item.name,
        poster: posterFor(item) || item.poster || "",
        mode: modes.get(item.id) || "av",
        formatId: pick.id || "",
        height: pick.height || 0,
      });
      opened.delete(item.id);
      names.delete(item.id);
      await refresh();
    } catch (e) {
      go.disabled = false;
      go.textContent = "Скачать";
      showAlert(e.message);
    }
  });

  // Два ряда, а не один: переключатель, выпадашка и кнопка в 344 пикселя
  // не помещаются и переносятся вразнобой.
  optRow.append(seg);
  const goRow = el("div", "row split");
  goRow.append(qualSel, go);
  card.append(optRow, goRow);
  return card;
}

async function loadFormats(item) {
  if (probes.has(item.id)) return;
  probes.set(item.id, null);
  try {
    const data = await send("probe", { itemId: item.id });
    const formats = (data.formats || []).length
      ? data.formats
      : [{ id: "", height: 0, label: "лучшее доступное" }];
    probes.set(item.id, { formats });
  } catch (e) {
    probes.set(item.id, { error: e.message, formats: [] });
  }
  if (opened.has(item.id)) render();
}

/**
 * Загрузки одной лентой: сверху идущие, ниже завершённые.
 * ⚠ Раньше это были два раздела, и готовая загрузка висела с галочкой
 * «готово», пока её не уберут крестиком, — при том что та же запись уже
 * стояла в «Завершено». Одно событие в двух местах человек читает как ошибку.
 */
function renderDownloads() {
  const jobs = Object.values(state.jobs).sort((a, b) => b.startedAt - a.startedAt);
  const history = state.history || [];
  $("#downloads-section").hidden = jobs.length === 0 && history.length === 0;
  $("#clear-history").hidden = history.length === 0;

  const box = $("#downloads");
  box.replaceChildren();
  jobs.forEach((job, i) => box.append(jobCard(job, i)));
  history.slice(0, 15).forEach((h, i) => box.append(historyCard(h, jobs.length + i)));
}

function jobCard(job, index) {
  const card = el("div", "card");
  stagger(card, `j:${job.id}`, index);

  const head = el("div", "card-head");
  head.append(thumb(job.poster, modeTag(job.mode)));
  const t = el("div", "title");
  t.append(el("div", null, job.name));
  if (job.stage) t.append(el("div", "sub", job.stage));
  head.append(t);
  card.append(head);

  if (job.status === "running") {
    const bar = el("div", "progress");
    const fill = el("i");
    fill.style.width = `${Math.min(100, job.percent || 0)}%`;
    bar.append(fill);
    card.append(bar);

    const stats = el("div", "stats");
    stats.append(el("span", "pct", `${(job.percent || 0).toFixed(0)} %`));
    if (job.speed) stats.append(el("span", null, fmtSpeed(job.speed)));
    if (job.total) stats.append(el("span", null, fmtSize(job.total)));
    stats.append(el("span", "spacer", job.eta ? `осталось ${fmtEta(job.eta)}` : ""));
    card.append(stats);

    const row = el("div", "row");
    const cancel = el("button", "ghost danger");
    cancel.append(icon("x"), el("span", null, "Отменить"));
    cancel.addEventListener("click", () => send("cancel", { jobId: job.id }).catch(showAlert));
    row.append(cancel);
    card.append(row);
    return card;
  }

  // Осталось только неудачное и отменённое: удачное уходит в историю само.
  const s = el("div", "state");
  s.append(
    icon(job.status === "error" ? "alert" : "pause"),
    el("span", null, job.status === "error" ? "не получилось" : "отменено"),
  );
  card.append(s);
  if (job.error) card.append(el("div", "err", job.error));
  card.append(hideRow(job.id));
  return card;
}

function historyCard(h, index) {
  const card = el("div", "card");
  stagger(card, `h:${h.id}`, index);

  const head = el("div", "card-head");
  head.append(thumb(h.poster, modeTag(h.mode)));
  const t = el("div", "title");
  t.append(el("div", null, h.name));
  const facts = [h.site, h.size ? fmtSize(h.size) : ""].filter(Boolean).join(" · ");
  t.append(el("div", "sub", facts));
  head.append(t);
  card.append(head);

  const row = el("div", "row");
  row.append(
    historyButton("play", "Играть", () => send("play", { path: h.file })),
    historyButton("folder", "Папка", () => send("open-folder", { path: h.file })),
  );
  const del = historyButton("trash", "Удалить", async () => {
    if (!confirm(`Удалить файл «${h.name}» с диска?`)) return;
    await send("delete-file", { path: h.file });
    await refresh();
  });
  del.classList.add("danger");
  row.append(del);
  card.append(row);
  return card;
}

function hideRow(jobId) {
  const row = el("div", "row");
  const b = el("button", "ghost");
  b.append(icon("x"), el("span", null, "Убрать"));
  b.addEventListener("click", () => send("hide-job", { jobId }).catch(showAlert));
  row.append(b);
  return row;
}

function modeTag(mode) {
  return mode === "a" ? "ЗВУК" : mode === "v" ? "БЕЗ ЗВУКА" : "ВИДЕО";
}

function historyButton(name, label, action) {
  const b = el("button", "ghost");
  b.append(icon(name), el("span", null, label));
  b.addEventListener("click", () => Promise.resolve(action()).catch(showAlert));
  return b;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

function showAlert(msgOrErr) {
  const box = $("#alert");
  box.replaceChildren(el("div", null, String(msgOrErr?.message || msgOrErr)));
  box.hidden = false;
}

/* ----------------------------------------------------------- запуск */

$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
// ⚠ Самое частое лекарство — перезагрузка страницы: плеер запрашивает
// плейлист ОДИН раз, при загрузке, и если расширение включилось позже, ловить
// уже нечего. Кнопка избавляет от объяснений «нажми F5».
$("#reload-tab").addEventListener("click", async () => {
  if (tabId == null) return;
  await chrome.tabs.reload(tabId);
  window.close();
});

$("#why").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("diag.html") });
  window.close();
});
$("#clear-history").addEventListener("click", async () => {
  await send("clear-history");
  await refresh();
});

/**
 * Начинка старше окна — предложить перезапуск.
 * ⚠ В Яндекс.Браузере кнопки «Обновить» на странице расширений нет, поэтому
 * перезапуск делается изнутри. Без этого правка кода не вступает в силу, а
 * выглядит как «не помогло».
 */
async function checkStaleBuild() {
  const { stale, running } = await checkStale();
  if (!stale) return false;
  const box = $("#alert");
  box.replaceChildren(
    el("div", null, `Расширение работает на устаревшей версии (${running}). Обновления не применены.`),
  );
  const btn = el("button", "go", "Перезапустить");
  btn.style.marginTop = "10px";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "перезапуск…";
    restart();
  });
  box.append(btn);
  box.hidden = false;
  return true;
}

async function checkHealth() {
  const box = $("#health");
  const text = box.querySelector(".health-text");
  try {
    const h = await send("health");
    if (h.ok && h.ytdlp && h.ffmpeg) {
      box.classList.add("ok");
      text.textContent = "загрузчик готов";
      return;
    }
    box.classList.add("bad");
    if (!h.ok) {
      text.textContent = "загрузчик недоступен";
      const a = $("#alert");
      a.replaceChildren(
        el("div", null, "Локальный загрузчик не отвечает. Установка выполняется один раз:"),
        el("code", null, "Видеолов\\helper\\установить.bat"),
      );
      a.hidden = false;
      return;
    }
    text.textContent = "не хватает компонентов";
    const miss = [!h.ytdlp && "yt-dlp", !h.ffmpeg && "ffmpeg"].filter(Boolean).join(" и ");
    showAlert(`Загрузчик работает, но не нашёл ${miss}. Установите недостающее и нажмите «Проверить снова» в настройках.`);
  } catch (e) {
    box.classList.add("bad");
    text.textContent = "загрузчик недоступен";
    showAlert(e.message);
  }
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // popup.html?tab=<номер> — открыть окно для чужой вкладки. Нужно, чтобы окно
  // можно было посмотреть отдельной страницей: открытое так, оно иначе считает
  // активной вкладкой само себя и показывает пустой список.
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  tabId = Number.isInteger(forced) && forced > 0 ? forced : (tab?.id ?? null);
  await refresh();
  // Сначала — не устарела ли начинка: если да, остальные проверки врут.
  if (await checkStaleBuild()) return;
  await checkHealth();
})();
