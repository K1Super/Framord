'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Renamer } = require('../electron/engine/renamer');

async function withFixture(run) {
  const root = path.join(os.tmpdir(), 'framord-rename-' + crypto.randomUUID());
  await fs.promises.mkdir(root, { recursive: true });
  const historyFile = path.join(root, 'history.json');
  const renamer = new Renamer(historyFile);
  const helpers = {
    root: root,
    renamer: renamer,
    historyFile: historyFile,
    file: function file(name) { return path.join(root, name); },
    write: async function write(name, content) {
      const target = path.join(root, name);
      await fs.promises.writeFile(target, content);
      return target;
    },
    read: function read(name) { return fs.promises.readFile(path.join(root, name), 'utf8'); },
    names: async function names() {
      return (await fs.promises.readdir(root)).filter(function skip(name) { return name !== 'history.json'; }).sort();
    }
  };
  try {
    await run(helpers);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test('批量改名后可通过历史撤销', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.jpg', 'A');
    const b = await ctx.write('b.jpg', 'B');
    const result = await ctx.renamer.execute([
      { from: a, to: ctx.file('2024_001.jpg') },
      { from: b, to: ctx.file('2024_002.jpg') }
    ]);
    assert.strictEqual(result.count, 2);
    assert.ok(result.entryId);
    assert.deepStrictEqual(await ctx.names(), ['2024_001.jpg', '2024_002.jpg']);
    assert.strictEqual(await ctx.read('2024_001.jpg'), 'A');

    const history = await ctx.renamer.listHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].count, 2);
    assert.strictEqual(history[0].undone, false);

    const undone = await ctx.renamer.undo(result.entryId);
    assert.strictEqual(undone.count, 2);
    assert.deepStrictEqual(await ctx.names(), ['a.jpg', 'b.jpg']);
    assert.strictEqual(await ctx.read('a.jpg'), 'A');
    assert.strictEqual((await ctx.renamer.listHistory())[0].undone, true);

    await assert.rejects(function secondUndo() { return ctx.renamer.undo(result.entryId); }, function verify(error) {
      return error.code === 'UNDO_DONE';
    });
  });
});

test('互换文件名（链式改名）不会覆盖内容', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.txt', 'A');
    const b = await ctx.write('b.txt', 'B');
    const result = await ctx.renamer.execute([
      { from: a, to: b },
      { from: b, to: a }
    ]);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(await ctx.read('a.txt'), 'B');
    assert.strictEqual(await ctx.read('b.txt'), 'A');

    await ctx.renamer.undo(result.entryId);
    assert.strictEqual(await ctx.read('a.txt'), 'A');
    assert.strictEqual(await ctx.read('b.txt'), 'B');
  });
});

test('目标已被占用时整批拒绝且不移动任何文件', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.jpg', 'A');
    const taken = await ctx.write('taken.jpg', 'KEEP');
    await assert.rejects(function run() {
      return ctx.renamer.execute([{ from: a, to: taken }]);
    }, function verify(error) {
      return error.code === 'TARGET_EXISTS';
    });
    assert.strictEqual(await ctx.read('a.jpg'), 'A');
    assert.strictEqual(await ctx.read('taken.jpg'), 'KEEP');
    assert.deepStrictEqual(await ctx.names(), ['a.jpg', 'taken.jpg']);
    assert.strictEqual((await ctx.renamer.listHistory()).length, 0);
  });
});

test('源文件缺失时拒绝执行', async function () {
  await withFixture(async function (ctx) {
    await assert.rejects(function run() {
      return ctx.renamer.execute([{ from: ctx.file('missing.jpg'), to: ctx.file('x.jpg') }]);
    }, function verify(error) {
      return error.code === 'SOURCE_MISSING';
    });
  });
});

test('仅大小写变化也能正确改名与撤销', async function () {
  await withFixture(async function (ctx) {
    const original = await ctx.write('Photo.JPG', 'X');
    const result = await ctx.renamer.execute([{ from: original, to: ctx.file('photo.JPG') }]);
    assert.strictEqual(result.count, 1);
    assert.deepStrictEqual(await ctx.names(), ['photo.JPG']);
    assert.strictEqual(await ctx.read('photo.JPG'), 'X');
    await ctx.renamer.undo(result.entryId);
    assert.deepStrictEqual(await ctx.names(), ['Photo.JPG']);
  });
});

test('非法目标名称被拒绝', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.jpg', 'A');
    await assert.rejects(function run() {
      return ctx.renamer.execute([{ from: a, to: ctx.file('bad:name.jpg') }]);
    }, function verify(error) {
      return error.code === 'INVALID_TARGET';
    });
    await assert.rejects(function run() {
      return ctx.renamer.execute([{ from: a, to: ctx.file('CON.jpg') }]);
    }, function verify(error) {
      return error.code === 'INVALID_TARGET';
    });
  });
});

test('撤销时原名已被外部占用则拒绝', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.jpg', 'A');
    const result = await ctx.renamer.execute([{ from: a, to: ctx.file('b.jpg') }]);
    await ctx.write('a.jpg', 'INTRUDER');
    await assert.rejects(function undo() {
      return ctx.renamer.undo(result.entryId);
    }, function verify(error) {
      return error.code === 'TARGET_EXISTS';
    });
    assert.strictEqual(await ctx.read('b.jpg'), 'A');
    assert.strictEqual(await ctx.read('a.jpg'), 'INTRUDER');
  });
});

test('中断批次可在启动时恢复原名', async function () {
  await withFixture(async function (ctx) {
    const original = ctx.file('orig.jpg');
    const target = ctx.file('renamed.jpg');
    const temp = ctx.file('.framord-test.tmp');
    await fs.promises.writeFile(temp, 'X');
    await fs.promises.writeFile(ctx.historyFile, JSON.stringify({
      version: 1,
      pending: {
        id: crypto.randomUUID(),
        at: Date.now(),
        kind: 'rename',
        items: [{ from: original, to: target, temp: temp }]
      },
      entries: []
    }));
    const result = await ctx.renamer.recoverPending();
    assert.strictEqual(result.recovered, 1);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(await ctx.read('orig.jpg'), 'X');
    assert.strictEqual(fs.existsSync(temp), false);
    const store = JSON.parse(await fs.promises.readFile(ctx.historyFile, 'utf8'));
    assert.strictEqual(store.pending, null);
  });
});

test('中断批次已完成最终名时也能恢复', async function () {
  await withFixture(async function (ctx) {
    const original = ctx.file('orig.jpg');
    const target = ctx.file('renamed.jpg');
    const temp = ctx.file('.framord-test.tmp');
    await fs.promises.writeFile(target, 'Y');
    await fs.promises.writeFile(ctx.historyFile, JSON.stringify({
      version: 1,
      pending: {
        id: crypto.randomUUID(),
        at: Date.now(),
        kind: 'rename',
        items: [{ from: original, to: target, temp: temp }]
      },
      entries: []
    }));
    const result = await ctx.renamer.recoverPending();
    assert.strictEqual(result.recovered, 1);
    assert.strictEqual(await ctx.read('orig.jpg'), 'Y');
    assert.deepStrictEqual(await ctx.names(), ['orig.jpg']);
  });
});

test('历史记录可跨实例读取', async function () {
  await withFixture(async function (ctx) {
    const a = await ctx.write('a.jpg', 'A');
    await ctx.renamer.execute([{ from: a, to: ctx.file('b.jpg') }]);
    const fresh = new Renamer(ctx.historyFile);
    const history = await fresh.listHistory();
    assert.strictEqual(history.length, 1);
    assert.deepStrictEqual(history[0].sample, [{ from: 'a.jpg', to: 'b.jpg' }]);
  });
});

test('空计划不产生历史记录', async function () {
  await withFixture(async function (ctx) {
    const result = await ctx.renamer.execute([]);
    assert.strictEqual(result.count, 0);
    assert.strictEqual((await ctx.renamer.listHistory()).length, 0);
    assert.deepStrictEqual(await ctx.names(), []);
  });
});
