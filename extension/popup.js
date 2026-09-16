// Окно расширения: список найденного, выбор качества, ход загрузок, история.

const $ = (sel) => document.querySelector(sel);

let tabId = null;
let state = { found: [], jobs: {}, history: [], settings: {} };
const probes = new Map(); // id находки → список качеств (чтобы не спрашивать дважды)
const opened = new Set(); // какие карточки раскрыты

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

function render() {
  renderFound();
  renderJobs();
  renderHistory();
}

function renderFound() {
  const box = $("#found");
  box.replaceChildren();
  $("#found-count").textContent = state.found.length ? `· ${state.found.length}` : "";
  $("#empty").hidden = state.found.length > 0;

  for (const item of state.found) box.append(foundCard(item));
}

function foundCard(item) {
  const card = el("div", "card");

  const head = el("div", "card-head");
  head.append(el("span", "tag", item.label));
  const titleBox = el("div", "title");
  titleBox.append(el("div", null, item.name || item.title || "без названия"));
  titleBox.append(el("div", "sub", shortUrl(item.url)));
  head.append(titleBox);
  card.append(head);

  const isOpen = opened.has(item.id);
  const toggle = el("button", "ghost", isOpen ? "Свернуть" : "Скачать…");
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
  nameInput.value = item.name || "";
  nameInput.title = "Имя файла — можно поправить до старта";
  nameRow.append(nameInput);
  card.append(nameRow);

  const optRow = el("div", "row");

  const modeSel = el("select");
  for (const [v, t] of [
    ["av", "Видео + звук"],
    ["a", "Только звук"],
    ["v", "Только видео"],
  ]) {
    const o = el("option", null, t);
    o.value = v;
    modeSel.append(o);
  }

  const qualSel = el("select");
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
        mode: modeSel.value,
        formatId: pick.id || "",
        height: pick.height || 0,
      });
      opened.delete(item.id);
      await refresh();
    } catch (e) {
      go.disabled = false;
      go.textContent = "Скачать";
      showAlert(e.message);
    }
  });

  optRow.append(modeSel, qualSel, go);
  card.append(optRow);

  // Звук перекодируется — список качеств видео к нему неприменим.
  modeSel.addEventListener("change", () => {
    qualSel.disabled = modeSel.value === "a" || !probes.get(item.id);
  });

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

  for (const job of jobs) {
    const card = el("div", "card");
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
      bar.append(fill, el("span", null, `${(job.percent || 0).toFixed(1)} %`));
      card.append(bar);

      const meta = el("div", "meta");
      if (job.speed) meta.append(el("span", null, fmtSpeed(job.speed)));
      if (job.eta) meta.append(el("span", null, `осталось ${fmtEta(job.eta)}`));
      if (job.total) meta.append(el("span", null, fmtSize(job.total)));
      card.append(meta);

      const row = el("div", "row");
      const cancel = el("button", "ghost danger", "Отменить");
      cancel.addEventListener("click", () => send("cancel", { jobId: job.id }).catch(showAlert));
      row.append(cancel);
      card.append(row);
    } else if (job.status === "error") {
      card.append(el("div", "err", job.error || "не получилось"));
      card.append(hideRow(job.id));
    } else if (job.status === "cancelled") {
      card.append(el("div", "sub", "отменено"));
      card.append(hideRow(job.id));
    } else {
      card.append(el("div", "done-mark", "готово"));
      card.append(hideRow(job.id));
    }

    box.append(card);
  }
}

function hideRow(jobId) {
  const row = el("div", "row");
  const b = el("button", "ghost", "Убрать");
  b.addEventListener("click", () => send("hide-job", { jobId }).catch(showAlert));
  row.append(b);
  return row;
}

function modeTag(mode) {
  return mode === "a" ? "ЗВУК" : mode === "v" ? "ВИДЕО" : "A+V";
}

function renderHistory() {
  const list = state.history || [];
  $("#history-section").hidden = list.length === 0;
  const box = $("#history");
  box.replaceChildren();

  for (const h of list.slice(0, 15)) {
    const card = el("div", "card");
    const head = el("div", "card-head");
    const t = el("div", "title");
    t.append(el("div", null, h.name));
    t.append(el("div", "sub", `${h.site || ""} ${h.size ? "· " + fmtSize(h.size) : ""}`.trim()));
    head.append(t);
    card.append(head);

    const row = el("div", "row");
    const play = el("button", "ghost", "Играть");
    play.addEventListener("click", () => send("play", { path: h.file }).catch(showAlert));
    const folder = el("button", "ghost", "Папка");
    folder.addEventListener("click", () => send("open-folder", { path: h.file }).catch(showAlert));
    const del = el("button", "ghost danger", "Удалить");
    del.addEventListener("click", async () => {
      if (!confirm(`Удалить файл «${h.name}» с диска?`)) return;
      try {
        await send("delete-file", { path: h.file });
        await refresh();
      } catch (e) {
        showAlert(e.message);
      }
    });
    row.append(play, folder, del);
    card.append(row);
    box.append(card);
  }
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
        el(
          "div",
          null,
          "Помощник не отвечает. Он ставится один раз — запусти установщик из папки проекта:",
        ),
        el("code", null, "Видеолов\\helper\\установить.bat"),
      );
      a.hidden = false;
      return;
    }
    text.textContent = "не хватает программ";
    const a = $("#alert");
    const miss = [!h.ytdlp && "yt-dlp", !h.ffmpeg && "ffmpeg"].filter(Boolean).join(" и ");
    a.replaceChildren(el("div", null, `Помощник работает, но не нашёл ${miss}.`));
    a.hidden = false;
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
