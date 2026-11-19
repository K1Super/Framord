'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HISTORY_VERSION = 1;
const MAX_ENTRIES = 50;
const MAX_ITEMS = 100000;
const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const IS_WINDOWS = process.platform === 'win32';

/**
 * 事务化重命名：两阶段（原名 → 临时名 → 目标名），
 * 执行前写入待处理日志，异常时统一回滚，成功后落盘撤销记录。
 */
class Renamer {
  constructor(historyFile) {
    this.historyFile = historyFile;
  }

  async listHistory() {
    const store = await this.#readStore();
    return store.entries.map(function summarize(entry) {
      return {
        id: entry.id,
        at: entry.at,
        count: entry.items.length,
        undone: !!entry.undone,
        sample: entry.items.slice(0, 3).map(function pair(item) {
          return { from: path.basename(item.from), to: path.basename(item.to) };
        })
      };
    });
  }

  async execute(rawItems, onProgress) {
    const validated = await this.validate(rawItems);
    const items = validated.items;
    if (!items.length) return { count: 0 };

    const store = await this.#readStore();
    const batch = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: 'rename',
      items: items.map(function withTemp(item) {
        return { from: item.from, to: item.to, temp: tempNameFor(item.from) };
      })
    };
    store.pending = batch;
    try {
      await this.#writeStore(store);
    } catch (error) {
      throw new RenameError('JOURNAL_READY_FAILED', '无法写入撤销记录，未执行任何改名：' + describeError(error));
    }

    const total = batch.items.length;
    const cache = new DirNameCache();
    try {
      for (let i = 0; i < total; i += 1) {
        const item = batch.items[i];
        await this.#rename(item.from, item.temp, cache);
        report(onProgress, 'stage', i + 1, total, item.from);
      }
    } catch (error) {
      const failures = await this.#restore(batch, cache);
      await this.#clearPending();
      throw new RenameError('STAGE_FAILED', '准备重命名时失败：' + describeError(error), { failures: failures });
    }

    try {
      for (let i = 0; i < total; i += 1) {
        const item = batch.items[i];
        await this.#rename(item.temp, item.to, cache);
        report(onProgress, 'finalize', i + 1, total, item.to);
      }
    } catch (error) {
      const failures = await this.#restore(batch, cache);
      await this.#clearPending();
      throw new RenameError('APPLY_FAILED', '重命名未全部完成，已回滚：' + describeError(error), { failures: failures });
    }

    try {
      await this.#commitBatch(batch);
    } catch (error) {
      const failures = await this.#restore(batch, cache);
      await this.#clearPending().catch(function ignore() {});
      throw new RenameError(
        'JOURNAL_FAILED',
        failures.length
          ? '撤销记录写入失败，且部分文件未能回滚，请检查后手动处理'
          : '撤销记录写入失败，已回滚全部改名',
        { failures: failures }
      );
    }

    return { count: total, entryId: batch.id };
  }

  async undo(id, onProgress) {
    const store = await this.#readStore();
    const entry = store.entries.find(function match(item) { return item.id === id; });
    if (!entry) throw new RenameError('UNDO_NOT_FOUND', '撤销记录不存在');
    if (entry.undone) throw new RenameError('UNDO_DONE', '该批次已经撤销过');

    const reverse = entry.items.map(function invert(item) {
      return { from: item.to, to: item.from };
    });
    const validated = await this.validate(reverse);
    const items = validated.items;

    if (!items.length) {
      entry.undone = true;
      await this.#writeStore(store);
      return { count: 0 };
    }

    const batch = {
      id: crypto.randomUUID(),
      at: Date.now(),
      kind: 'undo',
      undoId: id,
      items: items.map(function withTemp(item) {
        return { from: item.from, to: item.to, temp: tempNameFor(item.from) };
      })
    };
    store.pending = batch;
    try {
      await this.#writeStore(store);
    } catch (error) {
      throw new RenameError('JOURNAL_READY_FAILED', '无法写入撤销记录，未执行任何改名：' + describeError(error));
    }

    const cache = new DirNameCache();
    try {
      for (let i = 0; i < batch.items.length; i += 1) {
        await this.#rename(batch.items[i].from, batch.items[i].temp, cache);
        report(onProgress, 'stage', i + 1, batch.items.length, batch.items[i].from);
      }
      for (let i = 0; i < batch.items.length; i += 1) {
        await this.#rename(batch.items[i].temp, batch.items[i].to, cache);
        report(onProgress, 'finalize', i + 1, batch.items.length, batch.items[i].to);
      }
    } catch (error) {
      const failures = await this.#restore(batch, cache);
      await this.#clearPending().catch(function ignore() {});
      throw new RenameError('UNDO_FAILED', '撤销失败，已回滚：' + describeError(error), { failures: failures });
    }

    const latest = await this.#readStore();
    const target = latest.entries.find(function match(item) { return item.id === id; });
    if (target) target.undone = true;
    latest.pending = null;
    try {
      await this.#writeStore(latest);
    } catch (error) {
      throw new RenameError('UNDO_JOURNAL_FAILED', '文件已恢复原名，但撤销记录更新失败：' + describeError(error));
    }
    return { count: batch.items.length };
  }

  /**
   * 启动时恢复上次中断的批次：把文件还原到批次开始前的名称。
   */
  async recoverPending() {
    const store = await this.#readStore();
    if (!store.pending || !Array.isArray(store.pending.items) || !store.pending.items.length) {
      if (store.pending) {
        store.pending = null;
        await this.#writeStore(store);
      }
      return { recovered: 0, failures: [] };
    }
    const cache = new DirNameCache();
    const failures = await this.#restore(store.pending, cache);
    const recovered = store.pending.items.length - failures.length;
    store.pending = null;
    await this.#writeStore(store);
    return { recovered: recovered, failures: failures };
  }

  async validate(rawItems) {
    if (!Array.isArray(rawItems)) throw new RenameError('INVALID_INPUT', '重命名计划无效');
    if (rawItems.length > MAX_ITEMS) throw new RenameError('INVALID_INPUT', '单次改名数量超出上限');

    const sources = new Set();
    const targets = new Set();
    const items = [];

    for (const raw of rawItems) {
      if (!raw || typeof raw.from !== 'string' || typeof raw.to !== 'string') {
        throw new RenameError('INVALID_INPUT', '重命名计划包含无效条目');
      }
      if (raw.from.indexOf('\0') >= 0 || raw.to.indexOf('\0') >= 0) {
        throw new RenameError('INVALID_INPUT', '路径包含非法字符');
      }
      const from = path.resolve(raw.from);
      const to = path.resolve(raw.to);
      if (from === to) continue;

      const fromKey = normalizeKey(from);
      const targetKey = normalizeKey(to);
      if (sources.has(fromKey)) throw new RenameError('DUPLICATE_SOURCE', '同一文件被重复加入计划');
      sources.add(fromKey);

      if (normalizeKey(path.dirname(from)) !== normalizeKey(path.dirname(to))) {
        throw new RenameError('CROSS_DIRECTORY', '仅支持在原目录内重命名');
      }
      const base = path.basename(to);
      if (!base) throw new RenameError('INVALID_TARGET', '目标名称不能为空');
      if (ILLEGAL_NAME.test(base)) throw new RenameError('INVALID_TARGET', '目标名称包含非法字符：' + base);
      if (/[ .]$/.test(base)) throw new RenameError('INVALID_TARGET', '目标名称不能以空格或点结尾：' + base);
      if (RESERVED_NAME.test(base)) throw new RenameError('INVALID_TARGET', '目标名称是系统保留名：' + base);
      if (Buffer.byteLength(base, 'utf8') > 255) throw new RenameError('INVALID_TARGET', '目标名称过长：' + base);
      if (targets.has(targetKey)) throw new RenameError('DUPLICATE_TARGET', '存在重复的目标名称：' + base);
      targets.add(targetKey);

      const stat = await safeLstat(from);
      if (!stat || !stat.isFile()) throw new RenameError('SOURCE_MISSING', '文件不存在或不可访问：' + path.basename(from));

      items.push({ from: from, to: to, targetKey: targetKey });
    }

    for (const item of items) {
      if (item.targetKey === normalizeKey(item.from)) continue;
      if (sources.has(item.targetKey)) continue;
      const existing = await safeLstat(item.to);
      if (existing) throw new RenameError('TARGET_EXISTS', '目标已存在：' + path.basename(item.to));
    }

    return { items: items };
  }

  async #rename(from, to, cache) {
    await fs.promises.rename(nativePath(from), nativePath(to));
    cache.apply(from, to);
  }

  /**
   * 统一回滚：先把已完成项退回临时名，再按原顺序回到原名，避免链式改名互相覆盖。
   */
  async #restore(batch, cache) {
    const failures = [];
    const items = batch.items.slice();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      try {
        if (await cache.exists(item.to) && !(await cache.exists(item.temp)) && !(await cache.exists(item.from))) {
          await this.#rename(item.to, item.temp, cache);
        }
      } catch (error) {
        failures.push({ path: item.to, reason: describeError(error) });
      }
    }
    for (const item of items) {
      try {
        if (await cache.exists(item.temp)) {
          await this.#rename(item.temp, item.from, cache);
        } else if (!(await cache.exists(item.from))) {
          failures.push({ path: item.from, reason: '文件既不在原位置也不在临时位置' });
        }
      } catch (error) {
        failures.push({ path: item.from, reason: describeError(error) });
      }
    }
    return failures;
  }

  async #commitBatch(batch) {
    const store = await this.#readStore();
    store.pending = null;
    store.entries.unshift({
      id: batch.id,
      at: batch.at,
      items: batch.items.map(function pair(item) {
        return { from: item.from, to: item.to };
      }),
      undone: false
    });
    store.entries = store.entries.slice(0, MAX_ENTRIES);
    await this.#writeStore(store);
  }

  async #clearPending() {
    const store = await this.#readStore();
    if (!store.pending) return;
    store.pending = null;
    await this.#writeStore(store);
  }

  async #readStore() {
    let raw = null;
    try {
      raw = await fs.promises.readFile(this.historyFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.#quarantine().catch(function ignore() {});
      }
      return emptyStore();
    }
    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== HISTORY_VERSION || !Array.isArray(data.entries)) throw new Error('bad store');
      return {
        version: HISTORY_VERSION,
        pending: data.pending && Array.isArray(data.pending.items) ? data.pending : null,
        entries: data.entries
      };
    } catch (error) {
      await this.#quarantine().catch(function ignore() {});
      return emptyStore();
    }
  }

  async #writeStore(store) {
    await fs.promises.mkdir(path.dirname(this.historyFile), { recursive: true });
    const payload = JSON.stringify({
      version: HISTORY_VERSION,
      pending: store.pending || null,
      entries: store.entries || []
    });
    const tempFile = this.historyFile + '.tmp-' + crypto.randomBytes(4).toString('hex');
    await fs.promises.writeFile(tempFile, payload, 'utf8');
    await fs.promises.rename(tempFile, this.historyFile);
  }

  async #quarantine() {
    const target = this.historyFile + '.corrupt-' + Date.now();
    await fs.promises.rename(this.historyFile, target);
  }
}

class DirNameCache {
  constructor() {
    this.directories = new Map();
  }

  async #names(dir) {
    if (!this.directories.has(dir)) {
      let names = [];
      try {
        names = await fs.promises.readdir(nativePath(dir));
      } catch (error) {
        names = [];
      }
      this.directories.set(dir, new Set(names));
    }
    return this.directories.get(dir);
  }

  async exists(targetPath) {
    const dir = path.dirname(targetPath);
    const names = await this.#names(dir);
    return names.has(path.basename(targetPath));
  }

  apply(fromPath, toPath) {
    const fromDir = path.dirname(fromPath);
    const toDir = path.dirname(toPath);
    const fromNames = this.directories.get(fromDir);
    if (fromNames) fromNames.delete(path.basename(fromPath));
    const toNames = this.directories.get(toDir);
    if (toNames) toNames.add(path.basename(toPath));
    if (!this.directories.has(toDir)) this.directories.set(toDir, new Set([path.basename(toPath)]));
  }
}

class RenameError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RenameError';
    this.code = code;
    this.details = details || null;
  }
}

function emptyStore() {
  return { version: HISTORY_VERSION, pending: null, entries: [] };
}

function normalizeKey(targetPath) {
  return IS_WINDOWS ? targetPath.toLowerCase() : targetPath;
}

function tempNameFor(fromPath) {
  const dir = path.dirname(fromPath);
  return path.join(dir, '.framord-' + crypto.randomBytes(6).toString('hex') + '.tmp');
}

function nativePath(targetPath) {
  if (!IS_WINDOWS) return targetPath;
  const absolute = path.resolve(targetPath);
  if (absolute.startsWith('\\\\?\\')) return absolute;
  if (absolute.startsWith('\\\\')) return '\\\\?\\UNC\\' + absolute.slice(2);
  return '\\\\?\\' + absolute;
}

async function safeLstat(targetPath) {
  try {
    return await fs.promises.lstat(nativePath(targetPath));
  } catch (error) {
    return null;
  }
}

function describeError(error) {
  if (!error) return '未知错误';
  if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY') return '文件被占用或无权限';
  if (error.code === 'ENOENT') return '文件不存在';
  if (error.code === 'ENOSPC') return '磁盘空间不足';
  return error.message || String(error);
}

function report(callback, phase, done, total, name) {
  if (typeof callback !== 'function') return;
  try {
    callback({ phase: phase, done: done, total: total, name: name });
  } catch (error) {
    /* 进度回调异常不应中断改名 */
  }
}

module.exports = { Renamer, RenameError };
