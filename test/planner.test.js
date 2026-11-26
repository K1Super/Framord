'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Planner = require('../shared/planner');

const BASE = 'C:\\photos';
const DIR_INDEX = {};

function photo(name, overrides) {
  return Object.assign({
    path: path.join(BASE, name),
    dir: BASE,
    name: name,
    ext: Planner.extOf(name).toLowerCase(),
    size: 1024,
    mtime: new Date(2023, 0, 1).getTime(),
    captureDate: null
  }, overrides || {});
}

function build(files, options) {
  return Planner.buildPlan(files, Object.assign({
    mode: 'template',
    template: '{date}_{seq:3}',
    startIndex: 1,
    padWidth: 3,
    sortKey: 'name',
    sortDir: 'asc',
    dirIndex: DIR_INDEX
  }, options || {}));
}

test('清理非法字符与保留名', function () {
  assert.strictEqual(Planner.sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.strictEqual(Planner.sanitizeBaseName('  相册.  '), '相册');
  assert.strictEqual(Planner.sanitizeBaseName('CON'), '_CON');
  assert.strictEqual(Planner.sanitizeBaseName('com1.jpg'), '_com1.jpg');
  assert.strictEqual(Planner.sanitizeBaseName('   '), '');
  assert.strictEqual(Planner.sanitizeBaseName('a\nb'), 'a_b');
});

test('模板令牌与序号位数', function () {
  const date = new Date(2024, 2, 15, 8, 9, 10).getTime();
  const files = [
    photo('DSC_0001.JPG', { captureDate: date }),
    photo('DSC_0002.JPG', { captureDate: date })
  ];
  const plan = build(files, { template: '{date}_{time}_{seq:4}_{name}' });
  assert.strictEqual(plan.items[0].targetName, '20240315_080910_0001_DSC_0001.JPG');
  assert.strictEqual(plan.items[1].targetName, '20240315_080910_0002_DSC_0002.JPG');
  assert.strictEqual(plan.summary.rename, 2);
});

test('扩展名大小写保持不变，仅换模板时不产生额外变化', function () {
  const files = [photo('IMG_0001.JPG')];
  const plan = build(files, { template: '{name}' });
  assert.strictEqual(plan.items[0].targetName, 'IMG_0001.JPG');
  assert.strictEqual(plan.items[0].status, 'unchanged');
});

test('排序与序号起始值', function () {
  const files = [photo('b.jpg'), photo('a.jpg')];
  const asc = build(files, { sortKey: 'name', sortDir: 'asc', startIndex: 10, padWidth: 2, template: '{seq}' });
  assert.deepStrictEqual(asc.items.map(function name(item) { return item.targetName; }), ['10.jpg', '11.jpg']);
  const desc = build(files, { sortKey: 'name', sortDir: 'desc', startIndex: 10, padWidth: 2, template: '{seq}' });
  assert.deepStrictEqual(desc.items.map(function name(item) { return item.targetName; }), ['10.jpg', '11.jpg']);
  assert.strictEqual(desc.items[0].name, 'b.jpg');
});

test('重复目标会被标记且不可执行', function () {
  const files = [photo('a.jpg'), photo('b.jpg')];
  const plan = build(files, { template: 'same' });
  assert.strictEqual(plan.items[0].status, 'duplicate');
  assert.strictEqual(plan.items[1].status, 'duplicate');
  assert.strictEqual(plan.summary.rename, 0);
  assert.strictEqual(plan.summary.conflict, 2);
});

test('目标已存在于磁盘时标记冲突', function () {
  const files = [photo('a.jpg')];
  const plan = Planner.buildPlan(files, {
    mode: 'template',
    template: 'taken',
    dirIndex: { [BASE]: ['a.jpg', 'taken.jpg'] }
  });
  assert.strictEqual(plan.items[0].status, 'conflict');
  assert.strictEqual(plan.items[0].reason, '目标已存在');
});

test('链式目标允许，文件本身参与改名', function () {
  const files = [photo('a.jpg'), photo('b.jpg')];
  const plan = Planner.buildPlan(files, {
    mode: 'template',
    template: '{seq}',
    dirIndex: { [BASE]: ['a.jpg', 'b.jpg'] }
  });
  assert.strictEqual(plan.items[0].status, 'ok');
  assert.strictEqual(plan.items[0].targetName, '001.jpg');
  assert.strictEqual(plan.items[1].targetName, '002.jpg');
});

test('随机单词与随机码令牌', function () {
  const files = [photo('a.jpg', { randomWord: 'Aurora', randomCode: '7KX2QM' })];
  const plan = build(files, { template: '{word}_{rand}' });
  assert.strictEqual(plan.items[0].targetName, 'Aurora_7KX2QM.jpg');
  const alias = build(files, { template: '{word}-{code}' });
  assert.strictEqual(alias.items[0].targetName, 'Aurora-7KX2QM.jpg');
});

test('随机命名在重复预览时保持稳定', function () {
  const files = [
    photo('a.jpg', { randomWord: 'Aurora', randomCode: '7KX2QM' }),
    photo('b.jpg', { randomWord: 'Cedar', randomCode: 'P4MW9T' })
  ];
  const first = build(files, { template: '{word}_{rand}' });
  const second = build(files, { template: '{word}_{rand}' });
  assert.deepStrictEqual(
    second.items.map(function name(item) { return item.targetName; }),
    first.items.map(function name(item) { return item.targetName; })
  );
});

test('六位随机数字码令牌', function () {
  const files = [photo('a.jpg', { randomNumber: '481026' })];
  const plan = build(files, { template: '{rnum}_{name}' });
  assert.strictEqual(plan.items[0].targetName, '481026_a.jpg');
});

test('取消选中的条目不占用序号、不计入重复与统计', function () {
  const files = [photo('a.jpg'), photo('b.jpg')];
  const selected = new Set([files[1].path]);
  const plan = build(files, { template: 'same', selected: selected });
  assert.strictEqual(plan.items[0].status, 'unselected');
  assert.strictEqual(plan.items[0].targetName, '');
  assert.strictEqual(plan.items[1].status, 'ok');
  assert.strictEqual(plan.items[1].targetName, 'same.jpg');
  assert.strictEqual(plan.summary.selected, 1);
  assert.strictEqual(plan.summary.unselected, 1);
  assert.strictEqual(plan.summary.rename, 1);
});

test('查找替换与无效正则', function () {
  const files = [photo('DSC_0001.jpg'), photo('DSC_0002.jpg')];
  const plan = build(files, { mode: 'replace', find: 'DSC', replacement: '旅行' });
  assert.strictEqual(plan.items[0].targetName, '旅行_0001.jpg');
  assert.strictEqual(plan.items[1].targetName, '旅行_0002.jpg');

  const broken = build(files, { mode: 'replace', find: '(', replacement: 'x', regex: true });
  assert.strictEqual(broken.items[0].status, 'invalid');
  assert.strictEqual(broken.items[0].reason, '表达式无效');
  assert.strictEqual(broken.summary.rename, 0);
});

test('正则替换与大小写开关', function () {
  const files = [photo('IMG_2024_0001.jpg')];
  const plan = build(files, { mode: 'replace', find: '^IMG_(\\d{4})_', replacement: '$1-', regex: true });
  assert.strictEqual(plan.items[0].targetName, '2024-0001.jpg');

  const strict = build([photo('abc.jpg')], { mode: 'replace', find: 'ABC', replacement: 'x', caseSensitive: true });
  assert.strictEqual(strict.items[0].status, 'unchanged');
});

test('非法字符被净化并标记', function () {
  const files = [photo('a.jpg')];
  const plan = build(files, { template: '2024:03|15' });
  assert.strictEqual(plan.items[0].targetName, '2024_03_15.jpg');
  assert.strictEqual(plan.items[0].sanitized, true);
  assert.strictEqual(plan.items[0].status, 'ok');
});

test('手动改名优先于模板', function () {
  const files = [photo('a.jpg')];
  const plan = build(files, {
    template: 'x',
    overrides: { [files[0].path]: '手工名称' }
  });
  assert.strictEqual(plan.items[0].targetName, '手工名称.jpg');
});

test('空白模板产生无效名称', function () {
  const plan = build([photo('a.jpg')], { template: '   ' });
  assert.strictEqual(plan.items[0].status, 'invalid');
  assert.strictEqual(plan.items[0].reason, '名称为空');
});
