'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readCaptureDate, parseCaptureDate } = require('../electron/engine/exif');

function buildExifJpeg(dateString) {
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);
  tiff.writeUInt16LE(0x9003, 28);
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(20, 32);
  tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  tiff.write(dateString, 44, 'latin1');

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xd9])]);
}

test('解析 JPEG APP1 中的拍摄时间', function () {
  const buffer = buildExifJpeg('2024:03:15 08:09:10\0');
  const timestamp = parseCaptureDate(buffer);
  assert.strictEqual(timestamp, new Date(2024, 2, 15, 8, 9, 10).getTime());
});

test('日期缺失或越界时返回 null', function () {
  assert.strictEqual(parseCaptureDate(buildExifJpeg('2024:13:15 08:09:10\0')), null);
  assert.strictEqual(parseCaptureDate(Buffer.from('not an image')), null);
  assert.strictEqual(parseCaptureDate(Buffer.alloc(0)), null);
});

test('截断文件不会抛异常', function () {
  const full = buildExifJpeg('2024:03:15 08:09:10\0');
  for (let length = 0; length < full.length; length += 7) {
    assert.doesNotThrow(function parse() {
      parseCaptureDate(full.subarray(0, length));
    });
  }
});

test('从磁盘读取拍摄时间，无 EXIF 时返回 null', async function () {
  const root = path.join(os.tmpdir(), 'framord-exif-' + crypto.randomUUID());
  await fs.promises.mkdir(root, { recursive: true });
  try {
    const withExif = path.join(root, 'with.jpg');
    const plain = path.join(root, 'plain.jpg');
    await fs.promises.writeFile(withExif, buildExifJpeg('2022:12:31 23:59:58\0'));
    await fs.promises.writeFile(plain, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.strictEqual(await readCaptureDate(withExif), new Date(2022, 11, 31, 23, 59, 58).getTime());
    assert.strictEqual(await readCaptureDate(plain), null);
    assert.strictEqual(await readCaptureDate(path.join(root, 'missing.jpg')), null);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
