'use strict';

const fs = require('node:fs');

const HEADER_BYTES = 64 * 1024;

/**
 * 读取照片的拍摄时间。仅解析 JPEG / TIFF / PNG(eXIf) 的 EXIF 头，
 * 不支持的容器或损坏文件一律返回 null，由调用方回退到文件修改时间。
 */
async function readCaptureDate(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const result = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return parseCaptureDate(buffer.subarray(0, result.bytesRead));
  } catch (error) {
    return null;
  } finally {
    if (handle) await handle.close().catch(function ignore() {});
  }
}

function parseCaptureDate(buffer) {
  try {
    if (!buffer || buffer.length < 8) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return parseJpeg(buffer);
    if (buffer.toString('latin1', 0, 2) === 'II' || buffer.toString('latin1', 0, 2) === 'MM') return parseTiff(buffer, 0);
    if (buffer[0] === 0x89 && buffer.toString('latin1', 1, 4) === 'PNG') return parsePng(buffer);
    return null;
  } catch (error) {
    return null;
  }
}

function parseJpeg(buffer) {
  let offset = 2;
  const length = buffer.length;
  while (offset + 4 <= length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const size = buffer.readUInt16BE(offset + 2);
    if (size < 2) break;
    const segmentEnd = offset + 2 + size;
    if (segmentEnd > length) break;
    if (marker === 0xe1 && buffer.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') {
      return parseTiff(buffer, offset + 10);
    }
    offset = segmentEnd;
  }
  return null;
}

function parsePng(buffer) {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'eXIf') return parseTiff(buffer, dataStart);
    if (type === 'IDAT' || type === 'IEND') break;
    offset = dataStart + size + 4;
    if (size < 0) break;
  }
  return null;
}

function parseTiff(buffer, start) {
  if (start + 8 > buffer.length) return null;
  const order = buffer.toString('latin1', start, start + 2);
  let little;
  if (order === 'II') little = true;
  else if (order === 'MM') little = false;
  else return null;

  const view = {
    u16: function u16(offset) {
      return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    },
    u32: function u32(offset) {
      return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    }
  };

  if (view.u16(start + 2) !== 42) return null;
  const ifd0 = start + view.u32(start + 4);
  const ifd0Entries = readIfd(buffer, ifd0, view, start);
  if (!ifd0Entries) return null;

  const exifPointer = ifd0Entries.get(0x8769);
  if (exifPointer) {
    const exifIfd = start + exifPointer.value;
    const exifEntries = readIfd(buffer, exifIfd, view, start);
    if (exifEntries) {
      const original = exifEntries.get(0x9003);
      const digitized = exifEntries.get(0x9004);
      const parsed = parseExifDate(original ? original.text : null) || parseExifDate(digitized ? digitized.text : null);
      if (parsed) return parsed;
    }
  }

  const fallback = ifd0Entries.get(0x0132);
  return fallback ? parseExifDate(fallback.text) : null;
}

function readIfd(buffer, offset, view, tiffStart) {
  if (offset + 2 > buffer.length) return null;
  const count = view.u16(offset);
  if (count > 512) return null;
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > buffer.length) return entries;
    const tag = view.u16(entry);
    const type = view.u16(entry + 2);
    const valueCount = view.u32(entry + 4);
    const typeSize = TYPE_SIZES[type] || 0;
    const inline = !typeSize || valueCount * typeSize <= 4;
    // TIFF 内的值偏移相对 TIFF 头，需要加上头在文件缓冲区中的起点
    const valueOffset = inline ? entry + 8 : tiffStart + view.u32(entry + 8);
    const record = { type: type, count: valueCount, value: view.u32(entry + 8) };
    if (tag === 0x8769 && type === 4) {
      entries.set(tag, record);
      continue;
    }
    if (type === 2 && valueOffset >= 0 && valueOffset + 1 < buffer.length) {
      const textLength = Math.min(valueCount, 64, buffer.length - valueOffset);
      record.text = buffer.toString('latin1', valueOffset, valueOffset + textLength).replace(/\0.*$/, '');
    }
    entries.set(tag, record);
  }
  return entries;
}

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function parseExifDate(text) {
  if (!text) return null;
  const match = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

module.exports = { readCaptureDate, parseCaptureDate };
