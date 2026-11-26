'use strict';

const crypto = require('node:crypto');

// 随机码去掉了 0/1/I/L/O 等易混字符，保证读起来干净、口头转述不易出错
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

const NUMBER_MIN = 100000;
const NUMBER_MAX = 999999;

const WORDS = [
  'Aurora', 'Amber', 'Aspen', 'Atlas', 'Autumn', 'Azure', 'Basin', 'Beacon', 'Birch', 'Bloom',
  'Breeze', 'Brook', 'Cactus', 'Canyon', 'Cedar', 'Celeste', 'Cinder', 'Citrus', 'Clover', 'Coast',
  'Coral', 'Cove', 'Crescent', 'Crystal', 'Cypress', 'Dawn', 'Delta', 'Dune', 'Echo', 'Eclipse',
  'Ember', 'Falcon', 'Feather', 'Fern', 'Field', 'Fjord', 'Flare', 'Flint', 'Forest', 'Frost',
  'Gale', 'Garden', 'Glacier', 'Glen', 'Glow', 'Grove', 'Harbor', 'Haze', 'Heather', 'Horizon',
  'Indigo', 'Iris', 'Island', 'Ivy', 'Jade', 'Jasper', 'Juniper', 'Kite', 'Lagoon', 'Lake',
  'Lantern', 'Lark', 'Lava', 'Leaf', 'Ledge', 'Linen', 'Lotus', 'Lunar', 'Maple', 'Marsh',
  'Meadow', 'Mesa', 'Mist', 'Moon', 'Moss', 'Mural', 'Nest', 'Night', 'Nova', 'Oak',
  'Ocean', 'Olive', 'Onyx', 'Orbit', 'Orchid', 'Otter', 'Peak', 'Pearl', 'Pebble', 'Pine',
  'Plain', 'Plum', 'Polar', 'Pond', 'Prairie', 'Prism', 'Quartz', 'Rain', 'Raven', 'Reef',
  'Ridge', 'River', 'Rock', 'Rose', 'Sage', 'Sand', 'Sapphire', 'Shadow', 'Shore', 'Sierra',
  'Silver', 'Sky', 'Slate', 'Snow', 'Solstice', 'Song', 'Spark', 'Spring', 'Spruce', 'Star',
  'Stone', 'Storm', 'Stream', 'Summit', 'Sun', 'Surf', 'Thistle', 'Thunder', 'Tide', 'Timber',
  'Topaz', 'Trail', 'Tulip', 'Tundra', 'Twilight', 'Umber', 'Vale', 'Valley', 'Velvet', 'Violet',
  'Vista', 'Wave', 'Willow', 'Wind', 'Winter', 'Wolf', 'Wood', 'Zenith', 'Zephyr', 'Zinc'
];

/**
 * 为扫描结果分配随机单词、随机码与 6 位随机数字码。
 * 随机码与数字码均在整批照片内全局唯一，单词尽量不重复，照片数量超过词库时循环使用。
 */
function assignRandomNames(files) {
  const pool = shuffle(WORDS.slice());
  const usedCodes = new Set();
  const usedNumbers = new Set();
  files.forEach(function assign(file, index) {
    file.randomWord = pool[index % pool.length];
    file.randomCode = createCode(usedCodes);
    file.randomNumber = createNumber(usedNumbers);
  });
  return files;
}

function createCode(usedCodes) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let code = '';
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!/^[A-Z]/.test(code)) continue;
    if (!/[0-9]/.test(code)) continue;
    if (usedCodes.has(code)) continue;
    usedCodes.add(code);
    return code;
  }
  // 概率上不可达：极端情况下退化为十六进制随机串，仍需保证唯一
  const fallback = crypto.randomBytes(8).toString('hex').toUpperCase();
  usedCodes.add(fallback);
  return fallback;
}

/**
 * 生成 6 位纯数字随机码（100000–999999），批内唯一。
 * 区间接近占满时退化为顺序探测空位，避免死循环，仍保持 6 位与唯一。
 */
function createNumber(usedNumbers) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = crypto.randomInt(NUMBER_MIN, NUMBER_MAX + 1);
    if (usedNumbers.has(value)) continue;
    usedNumbers.add(value);
    return String(value);
  }
  const span = NUMBER_MAX - NUMBER_MIN + 1;
  const start = crypto.randomInt(NUMBER_MIN, NUMBER_MAX + 1);
  for (let offset = 0; offset < span; offset += 1) {
    const value = NUMBER_MIN + ((start - NUMBER_MIN + offset) % span);
    if (usedNumbers.has(value)) continue;
    usedNumbers.add(value);
    return String(value);
  }
  return '';
}

function shuffle(list) {
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    const current = list[index];
    list[index] = list[swap];
    list[swap] = current;
  }
  return list;
}

module.exports = { assignRandomNames, CODE_ALPHABET, CODE_LENGTH, WORDS };
