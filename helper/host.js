"use strict";
// Видеолов — помощник на компьютере.
//
// Запускается браузером (native messaging), общается кадрами через stdin/stdout:
// 4 байта длины (little-endian) + JSON в UTF-8. Ничего не слушает по сети.
//
// ⚠ В stdout нельзя писать НИЧЕГО, кроме кадров: одна отладочная строка ломает
// поток и браузер закрывает соединение. Всё, что хочется сказать, — в stderr,
// браузер складывает это в свой журнал.

const { tools, versionOf } = require("./lib/paths.js");
const ytdlp = require("./lib/ytdlp.js");
const shell = require("./lib/shell.js");

const MAX_FRAME = 64 * 1024 * 1024;

const jobs = new Map(); // jobId → {child, job}
let jobSeq = 0;

/* ------------------------------------------------------------- отправка */

function post(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

const reply = (id, data) => post({ t: "res", id, ok: true, data: data ?? {} });
const fail = (id, err) => post({ t: "res", id, ok: false, error: String(err?.message || err) });
const event = (kind, jobId, extra = {}) => post({ t: "event", kind, jobId, ...extra });

/* --------------------------------------------------------------- приём */

let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (len > MAX_FRAME) {
      process.stderr.write(`[видеолов] кадр не по размеру: ${len}\n`);
      process.exit(1);
    }
    if (buf.length < 4 + len) return;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    let msg = null;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      process.stderr.write(`[видеолов] кадр не разобрался: ${e.message}\n`);
      continue;
    }
    handle(msg);
  }
});

// Браузер закрыл соединение — уносим с собой все незавершённые загрузки,
// иначе yt-dlp останется писать файл, о котором никто не знает.
process.stdin.on("end", () => {
  for (const { child } of jobs.values()) ytdlp.killTree(child);
  process.exit(0);
});

/* ------------------------------------------------------------- команды */

function handle(msg) {
  if (!msg || msg.t !== "req") return;
  const { id, cmd, args = {} } = msg;
  try {
    switch (cmd) {
      case "ping":
        return reply(id, ping());

      case "probe":
        return ytdlp.probe(args, (err, data) => (err ? fail(id, err) : reply(id, data)));

      case "download":
        return reply(id, startJob(args));

      case "cancel":
        return reply(id, cancelJob(args.jobId));

      case "openFolder":
        return reply(id, shell.openFolder(args.path));

      case "play":
        return reply(id, shell.play(args.path));

      case "deleteFile":
        return reply(id, shell.deleteFile(args.path));

      case "pickFolder":
        return shell.pickFolder((err, data) => (err ? fail(id, err) : reply(id, data)));

      default:
        return fail(id, `неизвестная команда: ${cmd}`);
    }
  } catch (e) {
    process.stderr.write(`[видеолов] ${cmd} упала: ${e.stack || e}\n`);
    fail(id, e);
  }
}

function ping() {
  const t = tools();
  return {
    node: process.versions.node,
    ytdlp: Boolean(t.ytdlp),
    ffmpeg: Boolean(t.ffmpeg),
    ytdlpVersion: versionOf(t.ytdlp, ["--version"]),
    ffmpegVersion: (versionOf(t.ffmpeg, ["-version"]).match(/version (\S+)/) || [])[1] || "",
    downloadsDir: t.downloads,
  };
}

function startJob(job) {
  const jobId = `j${Date.now().toString(36)}${++jobSeq}`;
  const child = ytdlp.startDownload(job, (ev) => {
    const { kind, ...rest } = ev;
    event(kind, jobId, rest);
    if (kind === "done" || kind === "error") jobs.delete(jobId);
  });
  if (child) jobs.set(jobId, { child, job });
  return { jobId };
}

function cancelJob(jobId) {
  const entry = jobs.get(jobId);
  if (!entry) return { ok: true, already: true };
  entry.job.cancelled = true;
  ytdlp.killTree(entry.child);
  jobs.delete(jobId);
  return { ok: true };
}

process.on("uncaughtException", (e) => {
  process.stderr.write(`[видеолов] непойманная ошибка: ${e.stack || e}\n`);
});

process.stderr.write("[видеолов] помощник поднялся\n");
