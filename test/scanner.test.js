'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanFolder } = require('../electron/engine/scanner');

async function withRoot(run) {
  const root = path.join(os.tmpdir(), 'framord-scan-' + crypto.randomUUID());
  await fs.promises.mkdir(path.join(root, '子目录'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'a.png'), Buffer.alloc(24));
  await fs.promises.writeFile(path.join(root, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await fs.promises.writeFile(path.join(root, 'note.txt'), 'not a photo');
  await fs.promises.writeFile(path.join(root, '子目录', 'c.webp'), Buffer.alloc(16));
  try {
    await run(root);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test('扫描照片并分配随机单词与随机码', async function () {
  await withRoot(async function (root) {
    const data = await scanFolder({ dir: root, recursive: true, typeFilter: 'all' });
    assert.deepStrictEqual(
      data.files.map(function name(file) { return file.name; }).sort(),
      ['a.png', 'b.jpg', 'c.webp']
    );
    assert.strictEqual(data.files.length, 3);
    assert.strictEqual(data.stats.count, 3);
    assert.strictEqual(data.stats.folders, 2);
    assert.ok(Array.isArray(data.dirIndex[root]));
    assert.ok(data.dirIndex[root].includes('note.txt'));

    const codes = new Set();
    data.files.forEach(function verify(file) {
      assert.match(file.randomCode, /^[A-Z][A-Z0-9]{5}$/);
      assert.ok(file.randomWord);
      codes.add(file.randomCode);
    });
    assert.strictEqual(codes.size, 3);
  });
});

test('关闭子目录扫描时忽略嵌套照片', async function () {
  await withRoot(async function (root) {
    const data = await scanFolder({ dir: root, recursive: false, typeFilter: 'all' });
    assert.deepStrictEqual(
      data.files.map(function name(file) { return file.name; }).sort(),
      ['a.png', 'b.jpg']
    );
  });
});

test('类型筛选只保留指定格式', async function () {
  await withRoot(async function (root) {
    const data = await scanFolder({ dir: root, recursive: true, typeFilter: 'png' });
    assert.deepStrictEqual(data.files.map(function name(file) { return file.name; }), ['a.png']);
  });
});

test('目录不存在时抛出扫描错误', async function () {
  await assert.rejects(function run() {
    return scanFolder({ dir: path.join(os.tmpdir(), 'framord-missing-' + crypto.randomUUID()) });
  }, function verify(error) {
    return error.code === 'SCAN_FAILED';
  });
});
