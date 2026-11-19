'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readCaptureDate } = require('./exif');
const { assignRandomNames } = require('./randomizer');
const Planner = require('../../shared/planner');

const SKIP_DIRECTORIES = new Set(['$recycle.bin', 'system volume information']);
const EXIF_READABLE = new Set(['jpg', 'jpeg', 'tif', 'tiff', 'png']);
const MAX_DEPTH = 32;
const EXIF_CONCURRENCY = 8;

async function scanFolder(options) {
  const dir = path.resolve(String(options.dir || ''));
  const stat = await fs.promises.stat(dir).catch(function failed() { return null; });
  if (!stat || !stat.isDirectory()) {
    throw new ScanError('目录不存在或不可访问');
  }

  const allowed = new Set(Planner.filterExtensions(options.typeFilter));
  const recursive = options.recursive !== false;
  const files = [];
  const dirIndex = {};
  let unreadable = 0;

  async function walk(current, depth) {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (error) {
      unreadable += 1;
      return;
    }
    dirIndex[current] = entries.map(function name(entry) { return entry.name; });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!recursive || depth >= MAX_DEPTH) continue;
        const lower = entry.name.toLowerCase();
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(lower)) continue;
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      const ext = Planner.extOf(entry.name).toLowerCase();
      if (!ext || !allowed.has(ext)) continue;
      const fileStat = await fs.promises.stat(fullPath).catch(function failed() { return null; });
      if (!fileStat) continue;
      files.push({
        path: fullPath,
        dir: current,
        name: entry.name,
        ext: ext,
        size: fileStat.size,
        mtime: fileStat.mtimeMs,
        captureDate: null
      });
    }
  }

  await walk(dir, 0);
  assignRandomNames(files);
  await attachCaptureDates(files);

  let bytes = 0;
  for (const file of files) bytes += file.size;

  return {
    folder: dir,
    files: files,
    dirIndex: dirIndex,
    stats: {
      count: files.length,
      bytes: bytes,
      folders: Object.keys(dirIndex).length,
      unreadable: unreadable
    }
  };
}

async function attachCaptureDates(files) {
  const queue = files.filter(function needsDate(file) { return EXIF_READABLE.has(file.ext); });
  let cursor = 0;
  const workers = new Array(Math.min(EXIF_CONCURRENCY, queue.length)).fill(null).map(async function worker() {
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      const captureDate = await readCaptureDate(current.path);
      if (captureDate) current.captureDate = captureDate;
    }
  });
  await Promise.all(workers);
}

class ScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanError';
    this.code = 'SCAN_FAILED';
  }
}

module.exports = { scanFolder, ScanError };
