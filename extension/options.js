// Настройки: папка, число потоков, формат звука, проверка помощника.

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

let savedTimer = null;
function flashSaved() {
  const n = $("#saved");
  n.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (n.hidden = true), 1400);
}

async function save(patch) {
  await send("settings", { patch });
  flashSaved();
}

async function load() {
  const state = await send("state");
  const s = state.settings || {};
  $("#folder").value = s.folder || "";
  $("#perSite").checked = s.perSite !== false;
  $("#threads").value = s.threads || 16;
  $("#threads-val").textContent = s.threads || 16;
  paintSlider($("#threads"));
  $("#audioFormat").value = s.audioFormat || "m4a";
}

$("#pick").addEventListener("click", async () => {
  try {
    const data = await send("pick-folder");
    if (data?.folder) {
      $("#folder").value = data.folder;
      flashSaved();
    }
  } catch (e) {
    alert(`Не вышло открыть выбор папки: ${e.message}`);
  }
});

$("#reset-folder").addEventListener("click", async () => {
  $("#folder").value = "";
  await save({ folder: "" });
});

$("#perSite").addEventListener("change", (e) => save({ perSite: e.target.checked }));

/** Доля закрашенной дорожки ползунка — её рисует CSS через --fill. */
function paintSlider(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--fill", `${pct}%`);
}

$("#threads").addEventListener("input", (e) => {
  $("#threads-val").textContent = e.target.value;
  paintSlider(e.target);
});
$("#threads").addEventListener("change", (e) => save({ threads: Number(e.target.value) }));

$("#audioFormat").addEventListener("change", (e) => save({ audioFormat: e.target.value }));

async function health() {
  const box = $("#health");
  box.textContent = "проверяю…";
  try {
    const h = await send("health");
    if (!h.ok) {
      box.textContent = `Локальный загрузчик не отвечает: ${h.error}. Выполните установку: helper\\установить.bat`;
      return;
    }
    const bits = [
      h.ytdlp ? `yt-dlp ${h.ytdlpVersion || ""}`.trim() : "yt-dlp не найден",
      h.ffmpeg ? `ffmpeg ${h.ffmpegVersion || ""}`.trim() : "ffmpeg не найден",
      `Node.js ${h.node || "?"}`,
    ];
    box.textContent = bits.join(" · ");
  } catch (e) {
    box.textContent = `Локальный загрузчик не отвечает: ${e.message}`;
  }
}

$("#recheck").addEventListener("click", health);

// Открыть папку загрузок — чтобы не искать её в проводнике вручную.
$("#open-downloads").addEventListener("click", async () => {
  try {
    const h = await send("health");
    const state = await send("state");
    const folder = state.settings?.folder || h.downloadsDir;
    if (folder) await send("open-folder", { path: folder });
  } catch (e) {
    alert(`Не удалось открыть папку: ${e.message}`);
  }
});

void load();
void health();
