'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assignRandomNames, CODE_ALPHABET, CODE_LENGTH, WORDS } = require('../electron/engine/randomizer');

function makeFiles(count) {
  const files = [];
  for (let index = 0; index < count; index += 1) files.push({ path: 'C:\\photos\\' + index + '.jpg' });
  return files;
}

test('随机码格式统一且不含易混字符', function () {
  const files = assignRandomNames(makeFiles(200));
  const alphabet = new Set(CODE_ALPHABET.split(''));
  files.forEach(function verify(file) {
    assert.strictEqual(file.randomCode.length, CODE_LENGTH);
    assert.match(file.randomCode, /^[A-Z][A-Z0-9]*$/);
    assert.match(file.randomCode, /[0-9]/);
    for (const char of file.randomCode) assert.ok(alphabet.has(char), '非法字符：' + char);
    assert.ok(!/[01ILO]/.test(file.randomCode));
  });
});

test('大批量随机码保持唯一且单词来自词库', function () {
  const files = assignRandomNames(makeFiles(1200));
  const codes = new Set(files.map(function code(file) { return file.randomCode; }));
  assert.strictEqual(codes.size, files.length);
  files.forEach(function verify(file) {
    assert.ok(WORDS.includes(file.randomWord));
  });
});

test('单词数量不足时循环使用但随机码仍唯一', function () {
  const files = assignRandomNames(makeFiles(WORDS.length + 40));
  const codes = new Set(files.map(function code(file) { return file.randomCode; }));
  assert.strictEqual(codes.size, files.length);
  assert.ok(files.every(function word(file) { return file.randomWord; }));
});
