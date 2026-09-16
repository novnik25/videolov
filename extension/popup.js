// Окно расширения: список найденного, выбор качества, ход загрузок, история.

const $ = (sel) => document.querySelector(sel);

let tabId = null;
let state = { found: [], jobs: {}, history: [], settings: {} };
const probes = new Map(); // id находки → список качеств (чтобы не спрашивать дважды)
const opened = new Set(); // какие карточки раскрыты
const modes = new Map(); // id находки → выбранный режим
const names = new Map(); // id находки → имя, которое правит человек
const painted = new Set(); // что уже показывали: повторно не анимируем

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
  renderJobs();
  renderHistory();

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

function foundCard(item, index) {
  const card = el("div", "card");
  stagger(card, `f:${item.id}`, index);

  const head = el("div", "card-head");
  head.append(el("span", "tag", item.label));
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

function renderJobs() {
  const jobs = Object.values(state.jobs).sort((a, b) => b.startedAt - a.startedAt);
  $("#jobs-section").hidden = jobs.length === 0;
  const box = $("#jobs");
  box.replaceChildren();

  jobs.forEach((job, i) => {
    const card = el("div", "card");
    stagger(card, `j:${job.id}`, i);

    const head = el("div", "card-head");
    head.append(el("span", "tag", modeTag(job.mode)));
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
      const right = el("span", "spacer", job.eta ? `осталось ${fmtEta(job.eta)}` : "");
      stats.append(right);
      card.append(stats);

      const row = el("div", "row");
      const cancel = el("button", "ghost danger");
      cancel.append(icon("x"), el("span", null, "Отменить"));
      cancel.addEventListener("click", () => send("cancel", { jobId: job.id }).catch(showAlert));
      row.append(cancel);
      card.append(row);
    } else if (job.status === "error") {
      const s = el("div", "state");
      s.append(icon("alert"), el("span", null, "не получилось"));
      card.append(s);
      card.append(el("div", "err", job.error || ""));
      card.append(hideRow(job.id));
    } else if (job.status === "cancelled") {
      const s = el("div", "state");
      s.append(icon("pause"), el("span", null, "отменено"));
      card.append(s);
      card.append(hideRow(job.id));
    } else {
      const s = el("div", "state done");
      s.append(icon("check"), el("span", null, "готово"));
      card.append(s);
      card.append(hideRow(job.id));
    }

    box.append(card);
  });
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

function renderHistory() {
  const list = state.history || [];
  $("#history-section").hidden = list.length === 0;
  const box = $("#history");
  box.replaceChildren();

  list.slice(0, 15).forEach((h, i) => {
    const card = el("div", "card");
    stagger(card, `h:${h.id}`, i);

    const head = el("div", "card-head");
    const t = el("div", "title");
    t.append(el("div", null, h.name));
    t.append(el("div", "sub", [h.site, h.size ? fmtSize(h.size) : ""].filter(Boolean).join(" · ")));
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
    box.append(card);
  });
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
$("#why").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("diag.html") });
  window.close();
});
$("#clear-history").addEventListener("click", async () => {
  await send("clear-history");
  await refresh();
});

async function checkHealth() {
  const box = $("#health");
  const text = box.querySelector(".health-text");
  try {
    const h = await send("health");
    if (h.ok && h.ytdlp && h.ffmpeg) {
      box.classList.add("ok");
      text.textContent = "помощник на месте";
      return;
    }
    box.classList.add("bad");
    if (!h.ok) {
      text.textContent = "помощника нет";
      const a = $("#alert");
      a.replaceChildren(
        el("div", null, "Помощник не отвечает. Он ставится один раз — запусти установщик:"),
        el("code", null, "Видеолов\\helper\\установить.bat"),
      );
      a.hidden = false;
      return;
    }
    text.textContent = "не хватает программ";
    const miss = [!h.ytdlp && "yt-dlp", !h.ffmpeg && "ffmpeg"].filter(Boolean).join(" и ");
    showAlert(`Помощник работает, но не нашёл ${miss}.`);
  } catch (e) {
    box.classList.add("bad");
    text.textContent = "помощника нет";
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
  await checkHealth();
})();
