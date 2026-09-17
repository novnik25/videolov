"use strict";
// Действия в системе: показать файл, проиграть, удалить, выбрать папку.

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Строка аргументов для проводника.
 * ⚠ Node сам заключает аргумент в кавычки, когда в нём есть пробел, и получается
 * `"/select,C:\путь\Урок 6.mp4"` — кавычки охватывают И ключ. Проводник такую
 * строку не понимает: молча открывает «Документы» или не делает ничего. Ему
 * нужны кавычки ВНУТРИ: `/select,"C:\путь\Урок 6.mp4"`. Поэтому аргументы
 * собираются вручную и передаются дословно (windowsVerbatimArguments).
 * Поймано по жалобе: кнопка «Папка» не открывала папку. 16.09.2026.
 */
function explorerArgs(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* пути нет — откроем родительскую папку */
  }
  // Папку открываем, а не «выделяем»: выделение показало бы её в родительской.
  if (stat?.isDirectory()) return `"${file}"`;
  if (stat) return `/select,"${file}"`;
  return `"${path.dirname(file)}"`;
}

/** Показать файл в проводнике (выделенным). */
function openFolder(file) {
  if (!file) throw new Error("не знаю, какой файл показывать");
  // ⚠ explorer.exe возвращает код 1 даже при успехе — ошибку по коду не судим.
  spawn("explorer.exe", [explorerArgs(file)], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  }).unref();
  return { ok: true };
}

/** Открыть файл тем, чем система открывает такие файлы. */
function play(file) {
  if (!file || !fs.existsSync(file)) throw new Error("файла больше нет на диске");
  // ⚠ Та же ловушка, что и у проводника: start требует своих кавычек, причём
  // первый парный аргумент он считает ЗАГОЛОВКОМ окна — отсюда пустые "" перед
  // путём. Без дословной передачи путь с пробелами разваливается.
  spawn("cmd", [`/c start "" "${file}"`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    detached: true,
    stdio: "ignore",
  }).unref();
  return { ok: true };
}

function deleteFile(file) {
  if (!file) throw new Error("не знаю, что удалять");
  if (!fs.existsSync(file)) return { ok: true, already: true };
  fs.rmSync(file, { force: true });
  return { ok: true };
}

/**
 * Окно выбора папки.
 * ⚠ Скрипт пишется файлом с BOM, а не передаётся строкой: Windows PowerShell 5.1
 * читает и текст команды, и файл в системной кодировке, и кириллица в подписи
 * окна превращается в мусор либо валит разбор. BOM снимает оба вопроса.
 */
function pickFolder(done) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videolov-ps-"));
  const script = path.join(dir, "pick.ps1");
  const body = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    '$dlg.Description = "Куда Видеолов будет сохранять файлы"',
    "$dlg.ShowNewFolderButton = $true",
    // Окно поверх всех: иначе диалог уходит за браузер и выглядит зависанием.
    "$top = New-Object System.Windows.Forms.Form",
    "$top.TopMost = $true",
    "if ($dlg.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::Out.Write($dlg.SelectedPath)",
    "}",
    "$top.Dispose()",
    "",
  ].join("\r\n");
  fs.writeFileSync(script, "﻿" + body, "utf8");

  execFile(
    "powershell.exe",
    ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", script],
    { encoding: "utf8", windowsHide: true, timeout: 300000 },
    (err, stdout, stderr) => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* уберётся при очистке временных файлов */
      }
      if (err) return done(new Error(String(stderr || err.message).slice(0, 300)));
      const folder = String(stdout || "").trim();
      done(null, { folder });
    },
  );
}

module.exports = { openFolder, play, deleteFile, pickFolder, explorerArgs };
