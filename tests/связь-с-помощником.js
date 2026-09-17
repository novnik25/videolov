// Поддельный браузер: говорит с host.js теми же кадрами, что и настоящий.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ⚠ Папку чистим ДО прогона. Иначе yt-dlp видит уже скачанный файл, честно его
// пропускает — и проверка заканчивается словом «готово», не скачав ни байта.
// Поймано 16.09.2026: тиков прогресса пришло ноль, а выглядело как успех.
const OUT = path.join(os.tmpdir(), "videolov-host-test");
fs.rmSync(OUT, { recursive: true, force: true });

// Путь считаем от этого файла: проект переносим целиком, без правок.
const HOST = path.join(__dirname, "..", "helper", "host.js");
const child = spawn(process.execPath, [HOST], { windowsHide: true });

child.stderr.on("data", (d) => process.stdout.write("[stderr] " + d));

let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    onMessage(msg);
  }
});

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([head, body]));
}

const URL =
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
const job = {
  url: URL,
  name: "Кадровая проверка",
  mode: "a", // заодно проверяем режим «только звук»
  site: "apple.com",
  headers: { Referer: "https://разработчик.рф/курс/урок 1", "User-Agent": "Mozilla/5.0 (Windows NT 10.0)" },
  cookies: [{ domain: ".apple.com", path: "/", secure: true, expires: 0, name: "t", value: "1" }],
  settings: {
    folder: OUT,
    perSite: true,
    threads: 16,
    audioFormat: "m4a",
  },
};

let ticks = 0;
function onMessage(msg) {
  if (msg.t === "res" && msg.id === 1) {
    console.log("PING:", JSON.stringify(msg.data));
    send({ t: "req", id: 2, cmd: "probe", args: job });
    return;
  }
  if (msg.t === "res" && msg.id === 2) {
    console.log("PROBE:", msg.ok ? JSON.stringify(msg.data.formats.slice(0, 3)) : "ОШИБКА " + msg.error);
    send({ t: "req", id: 3, cmd: "download", args: job });
    return;
  }
  if (msg.t === "res" && msg.id === 3) {
    console.log("СТАРТ:", JSON.stringify(msg.data));
    return;
  }
  if (msg.t === "event" && msg.kind === "progress") {
    ticks++;
    return;
  }
  if (msg.t === "event") {
    console.log(`СОБЫТИЕ ${msg.kind}:`, JSON.stringify(msg));
    console.log("тиков прогресса:", ticks);
    const real = msg.kind === "done" && ticks > 0;
    if (!real) console.log("ПЛОХО: загрузки не было — прогресс не приходил");
    child.stdin.end();
    setTimeout(() => process.exit(real ? 0 : 1), 300);
  }
}

send({ t: "req", id: 1, cmd: "ping", args: {} });
