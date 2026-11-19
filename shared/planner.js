'use strict';

/**
 * 命名规划器：渲染层预览与主进程校验共用同一套命名规则。
 * 运行环境同时兼容 Node（require）与渲染进程（window.Planner）。
 */
(function initPlanner(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Planner = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPlanner() {
  const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
  const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  const MAX_BASE_LENGTH = 180;
  const TOKEN_PATTERN = /\{([a-z]+)(?::(\d{1,2}))?\}/gi;

  const PHOTO_EXTENSIONS = [
    'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff',
    'heic', 'heif', 'avif', 'jxl',
    'dng', 'cr2', 'cr3', 'nef', 'arw', 'srw', 'raf', 'orf', 'rw2', 'pef', 'x3f', 'srw'
  ];

  const TYPE_FILTERS = {
    all: null,
    jpeg: ['jpg', 'jpeg'],
    png: ['png'],
    heic: ['heic', 'heif', 'avif'],
    raw: ['dng', 'cr2', 'cr3', 'nef', 'arw', 'srw', 'raf', 'orf', 'rw2', 'pef', 'x3f'],
    tiff: ['tif', 'tiff']
  };

  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });

  function padNumber(value, width) {
    const text = String(Math.max(0, Math.trunc(value)));
    return text.length >= width ? text : '0'.repeat(width - text.length) + text;
  }

  function dateParts(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return {
      year: String(date.getFullYear()),
      month: padNumber(date.getMonth() + 1, 2),
      day: padNumber(date.getDate(), 2),
      hour: padNumber(date.getHours(), 2),
      minute: padNumber(date.getMinutes(), 2),
      second: padNumber(date.getSeconds(), 2)
    };
  }

  /**
   * 清理单个文件基础名：替换非法字符、去除首尾空白与结尾点、规避保留名。
   * 不抛异常，结果可能为空字符串，由调用方判定。
   */
  function sanitizeBaseName(input) {
    let name = String(input == null ? '' : input).replace(ILLEGAL_CHARS, '_');
    name = name.replace(/[\r\n\t]+/g, ' ').trim();
    name = name.replace(/[\s.]+$/g, '');
    name = name.replace(/^[\s]+/g, '');
    if (RESERVED_NAMES.test(name)) name = '_' + name;
    if (name.length > MAX_BASE_LENGTH) {
      name = Array.from(name).slice(0, MAX_BASE_LENGTH).join('');
      name = name.replace(/[\s.]+$/g, '');
    }
    return name;
  }

  function renderTemplate(template, context) {
    const parts = dateParts(context.date);
    return String(template == null ? '' : template).replace(TOKEN_PATTERN, function replacer(raw, token, widthText) {
      const key = token.toLowerCase();
      switch (key) {
        case 'name':
          return context.baseName;
        case 'ext':
          return context.ext;
        case 'folder':
          return context.folderName;
        case 'word':
          return context.word || '';
        case 'rand':
        case 'code':
        case 'random':
          return context.random || '';
        case 'seq':
        case 'index':
          return padNumber(context.index, widthText ? Math.min(8, Math.max(1, Number(widthText))) : context.padWidth);
        case 'date':
          return parts ? parts.year + parts.month + parts.day : '';
        case 'time':
          return parts ? parts.hour + parts.minute + parts.second : '';
        case 'year':
          return parts ? parts.year : '';
        case 'month':
          return parts ? parts.month : '';
        case 'day':
          return parts ? parts.day : '';
        case 'hour':
          return parts ? parts.hour : '';
        case 'minute':
          return parts ? parts.minute : '';
        case 'second':
          return parts ? parts.second : '';
        default:
          return raw;
      }
    });
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function applyReplace(baseName, options) {
    const find = String(options.find == null ? '' : options.find);
    if (!find) return baseName;
    let pattern;
    try {
      pattern = options.regex
        ? new RegExp(find, options.caseSensitive ? 'g' : 'gi')
        : new RegExp(escapeRegExp(find), options.caseSensitive ? 'g' : 'gi');
    } catch (error) {
      return null;
    }
    return baseName.replace(pattern, options.replacement == null ? '' : String(options.replacement));
  }

  function sortFiles(files, sortKey, direction) {
    const sign = direction === 'desc' ? -1 : 1;
    const list = files.slice();
    list.sort(function compare(a, b) {
      let result = 0;
      if (sortKey === 'capture') {
        const da = a.captureDate || a.mtime;
        const db = b.captureDate || b.mtime;
        result = da - db;
      } else if (sortKey === 'mtime') {
        result = a.mtime - b.mtime;
      } else if (sortKey === 'size') {
        result = a.size - b.size;
      }
      if (result === 0) result = collator.compare(a.name, b.name);
      if (result === 0) result = collator.compare(a.dir, b.dir);
      return result * sign;
    });
    return list;
  }

  function baseNameOf(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(0, dot) : fileName;
  }

  function extOf(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot + 1) : '';
  }

  /**
   * 生成重命名计划。files 为扫描结果，包含 path/dir/name/ext/size/mtime/captureDate。
   * dirIndex 记录每个目录下已有的全部条目名，用于检测目标占用。
   */
  function buildPlan(files, options) {
    const opts = options || {};
    const mode = opts.mode === 'replace' ? 'replace' : 'template';
    const sorted = sortFiles(files || [], opts.sortKey || 'name', opts.sortDir || 'asc');
    const dirIndex = opts.dirIndex || {};
    const overrides = opts.overrides || {};
    const selected = opts.selected instanceof Set ? opts.selected : null;
    const start = Number.isFinite(opts.startIndex) ? Math.trunc(opts.startIndex) : 1;
    const padWidth = Math.min(8, Math.max(1, Math.trunc(opts.padWidth || 3)));

    const items = [];
    let index = start;

    sorted.forEach(function each(file) {
      const isSelected = selected ? selected.has(file.path) : true;
      const ext = extOf(file.name);
      const baseName = baseNameOf(file.name);

      if (!isSelected) {
        items.push({
          path: file.path,
          dir: file.dir,
          name: file.name,
          ext: ext,
          size: file.size,
          mtime: file.mtime,
          captureDate: file.captureDate || null,
          targetName: '',
          targetPath: '',
          index: null,
          selected: false,
          status: 'unselected',
          reason: '未选择',
          sanitized: false
        });
        return;
      }

      // 输出沿用文件原始扩展名大小写，避免仅因扩展名大小写产生改名
      const folderName = file.dir.split(/[\\/]/).filter(Boolean).pop() || '';
      const date = file.captureDate ? new Date(file.captureDate) : new Date(file.mtime);
      let candidateBase = null;
      let invalidReason = '';

      if (Object.prototype.hasOwnProperty.call(overrides, file.path)) {
        candidateBase = overrides[file.path];
      } else if (mode === 'template') {
        candidateBase = renderTemplate(opts.template || '', {
          baseName: baseName,
          ext: ext,
          folderName: folderName,
          index: index,
          padWidth: padWidth,
          date: date,
          word: file.randomWord || '',
          random: file.randomCode || ''
        });
      } else {
        const replaced = applyReplace(baseName, {
          find: opts.find,
          replacement: opts.replacement,
          regex: !!opts.regex,
          caseSensitive: !!opts.caseSensitive
        });
        if (replaced === null) invalidReason = '表达式无效';
        else candidateBase = replaced;
      }

      const sanitizedBase = sanitizeBaseName(candidateBase);
      if (!sanitizedBase && !invalidReason) invalidReason = '名称为空';
      const targetName = sanitizedBase ? sanitizedBase + (ext ? '.' + ext : '') : '';

      const item = {
        path: file.path,
        dir: file.dir,
        name: file.name,
        ext: ext,
        size: file.size,
        mtime: file.mtime,
        captureDate: file.captureDate || null,
        targetName: targetName,
        targetPath: targetName ? joinPath(file.dir, targetName) : '',
        index: index,
        selected: true,
        status: 'ok',
        reason: '',
        sanitized: !!(candidateBase && sanitizedBase !== candidateBase)
      };

      if (invalidReason) {
        item.status = 'invalid';
        item.reason = invalidReason;
      } else if (targetName === file.name) {
        item.status = 'unchanged';
        item.reason = '无变化';
      }

      items.push(item);
      index += 1;
    });

    // 目标重名只在实际参与改名的条目之间判定
    const targetSeen = new Map();
    items.forEach(function detectDuplicate(item, position) {
      if (!item.selected || item.status !== 'ok') return;
      const key = item.targetPath.toLowerCase();
      if (!targetSeen.has(key)) {
        targetSeen.set(key, position);
        return;
      }
      const first = items[targetSeen.get(key)];
      item.status = 'duplicate';
      item.reason = '与第 ' + (targetSeen.get(key) + 1) + ' 项目标重名';
      if (first && first.status === 'ok') {
        first.status = 'duplicate';
        first.reason = '与第 ' + (position + 1) + ' 项目标重名';
      }
    });

    // 目标名称与磁盘上未参与改名的条目冲突检测
    const sourceBeingMoved = new Set();
    items.forEach(function collect(item) {
      if (item.selected && item.status === 'ok' && item.targetName !== item.name) {
        sourceBeingMoved.add(item.path.toLowerCase());
      }
    });

    items.forEach(function checkDisk(item) {
      if (!item.selected || item.status !== 'ok') return;
      if (item.targetName === item.name) return;
      const names = dirIndex[item.dir];
      if (!Array.isArray(names)) return;
      const targetKey = item.targetPath.toLowerCase();
      if (!names.some(function equals(name) { return joinPath(item.dir, name).toLowerCase() === targetKey; })) return;
      if (sourceBeingMoved.has(targetKey)) return;
      item.status = 'conflict';
      item.reason = '目标已存在';
    });

    const summary = {
      total: items.length,
      selected: 0,
      rename: 0,
      unchanged: 0,
      conflict: 0,
      invalid: 0,
      unselected: 0,
      bytes: 0
    };
    items.forEach(function count(item) {
      if (item.status === 'unselected') {
        summary.unselected += 1;
        return;
      }
      summary.selected += 1;
      if (item.status === 'ok') {
        summary.rename += 1;
        summary.bytes += item.size || 0;
      } else if (item.status === 'unchanged') summary.unchanged += 1;
      else if (item.status === 'invalid') summary.invalid += 1;
      else summary.conflict += 1;
    });

    return { items: items, summary: summary };
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    const last = dir.charAt(dir.length - 1);
    return last === '\\' || last === '/' ? dir + name : dir + '\\' + name;
  }

  function filterExtensions(typeFilter) {
    const key = TYPE_FILTERS[typeFilter] ? typeFilter : 'all';
    return TYPE_FILTERS[key] || PHOTO_EXTENSIONS;
  }

  return {
    PHOTO_EXTENSIONS: PHOTO_EXTENSIONS,
    TYPE_FILTERS: TYPE_FILTERS,
    MAX_BASE_LENGTH: MAX_BASE_LENGTH,
    sanitizeBaseName: sanitizeBaseName,
    renderTemplate: renderTemplate,
    buildPlan: buildPlan,
    sortFiles: sortFiles,
    filterExtensions: filterExtensions,
    extOf: extOf,
    baseNameOf: baseNameOf
  };
});
