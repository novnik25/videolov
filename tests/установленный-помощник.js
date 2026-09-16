// Проверка того самого пути, которым пойдёт браузер: манифест из реестра → .bat.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");

const key =
  "HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts\\ru.videolov.helper";
const out = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
const manifestPath = (out.match(/REG_SZ\s+(.+)/) || [])[1].trim();
console.log("реестр Яндекса указывает на:", manifestPath);

const man = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log("запускать:", man.path);
console.log("разрешено:", man.allowed_origins.join(", "));
console.log("запускалка на месте:", fs.existsSync(man.path));

// Node с версии 18.20 отказывается запускать .bat напрямую (spawn EINVAL) —
// это его собственная защита, а не свойство помощника. Браузер такого
// ограничения не имеет; здесь заходим через cmd, чтобы проверить ту же цепочку.
const child = spawn("cmd.exe", ["/c", man.path], { windowsHide: true });
child.stderr.on("data", (d) => process.stdout.write("[stderr] " + d));

let buf = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    console.log("ОТВЕТ:", buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    child.stdin.end();
    setTimeout(() => process.exit(0), 200);
  }
});

const body = Buffer.from(JSON.stringify({ t: "req", id: 1, cmd: "ping", args: {} }), "utf8");
const head = Buffer.alloc(4);
head.writeUInt32LE(body.length, 0);
child.stdin.write(Buffer.concat([head, body]));

setTimeout(() => {
  console.log("ОТВЕТА НЕТ — помощник не поднялся");
  process.exit(1);
}, 20000);
