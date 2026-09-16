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

$("#threads").addEventListener("input", (e) => {
  $("#threads-val").textContent = e.target.value;
});
$("#threads").addEventListener("change", (e) => save({ threads: Number(e.target.value) }));

$("#audioFormat").addEventListener("change", (e) => save({ audioFormat: e.target.value }));

async function health() {
  const box = $("#health");
  box.textContent = "проверяю…";
  try {
    const h = await send("health");
    if (!h.ok) {
      box.textContent = `Помощник не отвечает: ${h.error}. Запусти установщик helper\\установить.bat из папки проекта.`;
      return;
    }
    const bits = [
      h.ytdlp ? `yt-dlp ${h.ytdlpVersion || ""}`.trim() : "yt-dlp НЕ НАЙДЕН",
      h.ffmpeg ? `ffmpeg ${h.ffmpegVersion || ""}`.trim() : "ffmpeg НЕ НАЙДЕН",
      `узел ${h.node || "?"}`,
      `папка по умолчанию: ${h.downloadsDir || "?"}`,
    ];
    box.textContent = bits.join(" · ");
  } catch (e) {
    box.textContent = `Помощник не отвечает: ${e.message}`;
  }
}

$("#recheck").addEventListener("click", health);

void load();
void health();
