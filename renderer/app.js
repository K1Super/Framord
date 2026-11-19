'use strict';

(function main() {
  const $ = function id(target) { return document.getElementById(target); };
  const api = window.api;
  const Planner = window.Planner;
  const ROW_H = 44;

  const state = {
    folder: '',
    recursive: true,
    typeFilter: 'all',
    sortKey: 'name',
    sortDir: 'asc',
    mode: 'template',
    template: '',
    startIndex: 1,
    padWidth: 3,
    find: '',
    replacement: '',
    regex: false,
    caseSensitive: false,
    files: [],
    dirIndex: {},
    stats: null,
    overrides: {},
    selected: new Set(),
    onlyChanged: false,
    items: [],
    summary: null,
    history: [],
    busy: false,
    editingPath: null
  };

  const elements = {
    scroller: $('scroller'),
    track: $('track'),
    rowList: $('rowList'),
    previewHead: document.querySelector('.preview-head'),
    emptyState: $('emptyState'),
    emptyTitle: $('emptyTitle'),
    emptySub: $('emptySub'),
    summary: $('summary'),
    runBtn: $('runBtn'),
    undoBtn: $('undoBtn'),
    selectAll: $('selectAll'),
    historyList: $('historyList'),
    historyCount: $('historyCount'),
    toastHolder: $('toastHolder'),
    busy: $('busy'),
    busyLabel: $('busyLabel'),
    busyCount: $('busyCount'),
    busyFill: $('busyFill'),
    templateInput: $('templateInput'),
    topPath: $('topPath')
  };

  let visibleItems = [];
  let renderWindow = { start: -1, end: -1 };
  let recomputeQueued = false;

  init();

  function init() {
    bindEvents();
    applyMode('template');
    syncControls();
    syncNumberControls();
    loadStartup();
  }

  function syncNumberControls() {
    const usesSequence = /\{(seq|index)(:\d{1,2})?\}/i.test(state.template);
    $('numRow').hidden = !usesSequence;
  }

  function bindEvents() {
    $('pickBtn').addEventListener('click', chooseFolder);
    $('revealBtn').addEventListener('click', async function reveal() {
      if (!state.folder) return;
      try {
        const result = await api.reveal(state.folder);
        if (!result.ok) toast(result.message || '无法打开该位置', { tone: 'bad' });
      } catch (error) {
        toast('无法打开该位置', { tone: 'bad' });
      }
    });
    $('recursiveToggle').addEventListener('change', function toggle(event) {
      state.recursive = event.target.checked;
      if (state.folder) scanFolder(state.folder);
    });
    $('typeFilter').addEventListener('change', function filter(event) {
      state.typeFilter = event.target.value;
      if (state.folder) scanFolder(state.folder);
    });
    $('sortKey').addEventListener('change', function sort(event) {
      state.sortKey = event.target.value;
      scheduleRecompute();
    });
    $('sortDirGroup').addEventListener('click', function direction(event) {
      const button = event.target.closest('[data-dir]');
      if (!button) return;
      state.sortDir = button.dataset.dir;
      document.querySelectorAll('#sortDirGroup .seg-btn').forEach(function sync(item) {
        item.classList.toggle('is-active', item === button);
      });
      scheduleRecompute();
    });

    document.querySelectorAll('.tab').forEach(function bindTab(tab) {
      tab.addEventListener('click', function click() {
        applyMode(tab.dataset.mode);
      });
    });

    elements.templateInput.addEventListener('input', function templateChanged() {
      state.template = elements.templateInput.value;
      syncNumberControls();
      scheduleRecompute();
    });
    $('tokens').addEventListener('click', function tokenClick(event) {
      const button = event.target.closest('[data-token]');
      if (!button) return;
      const input = elements.templateInput;
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? start : input.selectionEnd;
      input.setRangeText(button.dataset.token, start, end, 'end');
      input.focus();
      state.template = input.value;
      syncNumberControls();
      scheduleRecompute();
    });

    $('startIndex').addEventListener('input', function startChanged(event) {
      const value = Number(event.target.value);
      state.startIndex = Number.isFinite(value) ? Math.trunc(value) : 1;
      scheduleRecompute();
    });
    $('padWidth').addEventListener('input', function padChanged(event) {
      const value = Number(event.target.value);
      state.padWidth = Number.isFinite(value) ? Math.min(8, Math.max(1, Math.trunc(value))) : 3;
      scheduleRecompute();
    });

    $('findInput').addEventListener('input', function findChanged(event) {
      state.find = event.target.value;
      scheduleRecompute();
    });
    $('replaceInput').addEventListener('input', function replaceChanged(event) {
      state.replacement = event.target.value;
      scheduleRecompute();
    });
    $('regexToggle').addEventListener('change', function regexChanged(event) {
      state.regex = event.target.checked;
      scheduleRecompute();
    });
    $('caseToggle').addEventListener('change', function caseChanged(event) {
      state.caseSensitive = event.target.checked;
      scheduleRecompute();
    });

    $('onlyChanged').addEventListener('change', function onlyChanged(event) {
      state.onlyChanged = event.target.checked;
      renderRows(true);
    });

    elements.selectAll.addEventListener('change', function selectAll(event) {
      const shouldSelect = event.target.checked;
      state.selected = new Set();
      if (shouldSelect) state.files.forEach(function add(file) { state.selected.add(file.path); });
      recompute();
    });

    elements.rowList.addEventListener('change', function rowCheck(event) {
      const checkbox = event.target.closest('[data-role="select"]');
      if (!checkbox) return;
      const row = checkbox.closest('.row');
      if (!row) return;
      const path = row.dataset.path;
      if (checkbox.checked) state.selected.add(path);
      else state.selected.delete(path);
      recompute();
    });

    elements.rowList.addEventListener('dblclick', function startEdit(event) {
      const cell = event.target.closest('[data-role="target"]');
      if (!cell) return;
      const row = cell.closest('.row');
      if (!row) return;
      beginEdit(row.dataset.path, cell);
    });

    elements.rowList.addEventListener('keydown', function editKeys(event) {
      const input = event.target.closest('.cell-edit');
      if (!input) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitEdit(input);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        state.editingPath = null;
        renderRows(true);
      }
    });

    elements.rowList.addEventListener('focusout', function editBlur(event) {
      const input = event.target.closest('.cell-edit');
      if (input) commitEdit(input);
    });

    $('resetOverrides').addEventListener('click', function reset() {
      state.overrides = {};
      scheduleRecompute();
    });

    elements.emptyState.addEventListener('click', function openFromEmpty() {
      if (!state.busy) chooseFolder();
    });

    elements.runBtn.addEventListener('click', runRename);
    elements.undoBtn.addEventListener('click', function undoLatest() {
      const entry = state.history.find(function find(item) { return !item.undone; });
      if (entry) undoEntry(entry.id);
    });

    elements.historyList.addEventListener('click', function historyClick(event) {
      const button = event.target.closest('[data-action="undo"]');
      if (!button) return;
      undoEntry(button.dataset.id);
    });

    elements.scroller.addEventListener('scroll', function scrolled() {
      renderRows(false);
    });

    window.addEventListener('resize', function resized() {
      renderRows(true);
    });

    document.addEventListener('keydown', function escape(event) {
      if (event.key === 'Escape' && state.editingPath) {
        state.editingPath = null;
        renderRows(true);
      }
    });

    bindDrop();
  }

  function bindDrop() {
    let depth = 0;
    window.addEventListener('dragenter', function enter(event) {
      event.preventDefault();
      depth += 1;
      document.body.classList.add('is-dragover');
    });
    window.addEventListener('dragover', function over(event) {
      event.preventDefault();
    });
    window.addEventListener('dragleave', function leave(event) {
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('is-dragover');
    });
    window.addEventListener('drop', async function drop(event) {
      event.preventDefault();
      depth = 0;
      document.body.classList.remove('is-dragover');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;
      try {
        const droppedPath = api.pathForFile(file);
        if (!droppedPath) return;
        const resolved = await api.resolveDrop(droppedPath);
        if (!resolved.ok) {
          toast(resolved.message || '无法读取该位置', { tone: 'bad' });
          return;
        }
        scanFolder(resolved.data.dir);
      } catch (error) {
        toast('无法读取拖入的位置', { tone: 'bad' });
      }
    });
  }

  function applyMode(mode) {
    state.mode = mode === 'replace' ? 'replace' : 'template';
    document.querySelectorAll('.tab').forEach(function sync(tab) {
      const active = tab.dataset.mode === state.mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('paneTemplate').hidden = state.mode !== 'template';
    $('paneReplace').hidden = state.mode !== 'replace';
    syncNumberControls();
    scheduleRecompute();
  }

  async function chooseFolder() {
    try {
      const folder = await api.pickFolder();
      if (folder) scanFolder(folder);
    } catch (error) {
      toast('无法打开文件夹选择器', { tone: 'bad' });
    }
  }

  async function scanFolder(folder, options) {
    const silent = !!(options && options.silent);
    if (state.busy) return;
    setBusy(true, '正在扫描', '读取目录与拍摄时间');
    let response;
    try {
      response = await api.scan({ dir: folder, recursive: state.recursive, typeFilter: state.typeFilter });
    } catch (error) {
      toast('扫描失败：' + error.message, { tone: 'bad' });
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      toast(response.message || '扫描失败', { tone: 'bad' });
      return;
    }
    const data = response.data;
    state.folder = data.folder;
    state.files = data.files;
    state.dirIndex = data.dirIndex;
    state.stats = data.stats;
    state.overrides = {};
    state.selected = new Set(data.files.map(function path(file) { return file.path; }));
    state.editingPath = null;
    elements.scroller.scrollTop = 0;
    renderWindow = { start: -1, end: -1 };
    updateSourceUI();
    recompute();
    if (data.stats.unreadable > 0) {
      toast('有 ' + data.stats.unreadable + ' 个目录无法读取', { tone: 'bad' });
    }
    if (!silent && data.files.length === 0) {
      toast('该位置没有符合条件的照片');
    }
  }

  function updateSourceUI() {
    const hasFolder = !!state.folder;
    $('revealBtn').disabled = !hasFolder;
    elements.topPath.textContent = hasFolder ? compactPath(state.folder, 88) : '未选择来源';
    elements.topPath.title = state.folder || '';
    $('metricCount').textContent = hasFolder ? String(state.stats.count) : '0';
    $('metricBytes').textContent = hasFolder ? formatBytes(state.stats.bytes) : '—';
    $('metricFolders').textContent = hasFolder ? String(state.stats.folders) : '—';
    document.title = hasFolder ? 'Framord · ' + baseName(state.folder) : 'Framord';
  }

  function compactPath(fullPath, limit) {
    const max = limit || 72;
    if (fullPath.length <= max) return fullPath;
    const parts = fullPath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return fullPath;
    return '…\\' + parts.slice(-2).join('\\');
  }

  function baseName(fullPath) {
    const parts = fullPath.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : fullPath;
  }

  function scheduleRecompute() {
    if (recomputeQueued) return;
    recomputeQueued = true;
    requestAnimationFrame(function run() {
      recomputeQueued = false;
      recompute();
    });
  }

  function recompute() {
    if (!state.files.length) {
      state.items = [];
      state.summary = null;
      renderRows(true);
      renderSummary();
      updateHistoryButtons();
      return;
    }
    const plan = Planner.buildPlan(state.files, {
      mode: state.mode,
      template: state.template || '{name}',
      find: state.find,
      replacement: state.replacement,
      regex: state.regex,
      caseSensitive: state.caseSensitive,
      startIndex: state.startIndex,
      padWidth: state.padWidth,
      sortKey: state.sortKey,
      sortDir: state.sortDir,
      dirIndex: state.dirIndex,
      overrides: state.overrides,
      selected: state.selected
    });
    state.items = plan.items;
    state.summary = plan.summary;
    renderRows(true);
    renderSummary();
    updateHistoryButtons();
  }

  function getVisibleItems() {
    if (!state.onlyChanged) return state.items;
    return state.items.filter(function changed(item) {
      return item.status !== 'unchanged' && item.status !== 'unselected';
    });
  }

  function syncPreviewGutter() {
    const scroller = elements.scroller;
    const head = elements.previewHead;
    if (!scroller || !head) return;
    const gutter = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    const base = parseFloat(getComputedStyle(head).paddingLeft) || 18;
    head.style.paddingRight = (base + gutter) + 'px';
  }

  function renderRows(resetWindow) {
    visibleItems = getVisibleItems();
    const count = visibleItems.length;
    elements.track.style.height = count * ROW_H + 'px';
    elements.emptyState.hidden = count > 0;
    if (resetWindow) syncPreviewGutter();

    if (!state.files.length) {
      elements.emptyTitle.textContent = '拖入文件夹';
      elements.emptySub.textContent = 'JPEG · PNG · HEIC · TIFF · RAW';
      elements.rowList.innerHTML = '';
      renderWindow = { start: -1, end: -1 };
      return;
    }
    if (count === 0) {
      elements.emptyTitle.textContent = state.onlyChanged ? '没有需要改名的文件' : '未发现照片';
      elements.emptySub.textContent = state.onlyChanged ? '关闭“仅显示变更”查看全部' : '检查类型筛选或更换文件夹';
      elements.rowList.innerHTML = '';
      renderWindow = { start: -1, end: -1 };
      return;
    }

    const scrollTop = elements.scroller.scrollTop;
    const viewport = elements.scroller.clientHeight || 400;
    let start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
    let end = Math.min(count, Math.ceil((scrollTop + viewport) / ROW_H) + 6);
    if (!resetWindow && renderWindow.start === start && renderWindow.end === end) return;

    const pieces = [];
    for (let index = start; index < end; index += 1) {
      pieces.push(rowMarkup(visibleItems[index], index));
    }
    elements.rowList.style.transform = 'translateY(' + start * ROW_H + 'px)';
    elements.rowList.innerHTML = pieces.join('');
    renderWindow = { start: start, end: end };
  }

  function rowMarkup(item, index) {
    const selected = item.selected;
    const statusClass = item.status === 'ok'
      ? (item.sanitized ? 'is-note' : '')
      : (item.status === 'unchanged' || item.status === 'unselected')
        ? 'is-muted'
        : 'is-bad';
    const classes = ['row'];
    if (!selected) classes.push('is-off');
    if (item.status === 'conflict' || item.status === 'duplicate') classes.push('is-conflict');
    const timeText = item.captureDate ? formatDateTime(item.captureDate) : formatDateTime(item.mtime);
    const timeClass = item.captureDate ? 'cell-time' : 'cell-time is-filetime';
    const timeTitle = item.captureDate ? 'EXIF 拍摄时间' : '文件修改时间';
    const stateText = item.status === 'ok'
      ? (item.sanitized ? '已净化' : '待执行')
      : item.status === 'unchanged'
        ? '无变化'
        : item.status === 'unselected'
          ? '未选择'
          : item.reason || '名称无效';

    return '<div class="' + classes.join(' ') + '" data-path="' + escapeAttr(item.path) + '">'
      + '<div class="cell-check"><input type="checkbox" data-role="select"' + (selected ? ' checked' : '') + ' aria-label="选择"></div>'
      + '<div class="cell-index">' + String(index + 1).padStart(2, '0') + '</div>'
      + '<div class="cell-name cell-source" title="' + escapeAttr(item.name) + '">' + escapeHtml(item.name) + '</div>'
      + '<div class="cell-mark"></div>'
      + '<div class="cell-name cell-target' + (item.status === 'unchanged' ? ' is-unchanged' : '') + '" data-role="target" title="' + escapeAttr(item.targetName || '—') + '">' + escapeHtml(item.targetName || '—') + '</div>'
      + '<div class="' + timeClass + '" title="' + timeTitle + '">' + timeText + '</div>'
      + '<div class="cell-size">' + formatBytes(item.size) + '</div>'
      + '<div class="cell-state ' + statusClass + '" title="' + escapeAttr(stateText) + '">' + escapeHtml(stateText) + '</div>'
      + '</div>';
  }

  function beginEdit(path, cell) {
    if (state.busy) return;
    const item = visibleItems.find(function find(entry) { return entry.path === path; });
    if (!item || !item.selected) return;
    state.editingPath = path;
    const input = document.createElement('input');
    input.className = 'cell-edit';
    input.value = item.targetName || item.name;
    input.spellcheck = false;
    input.dataset.path = path;
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }

  function commitEdit(input) {
    if (!state.editingPath) return;
    const path = input.dataset.path;
    const raw = input.value;
    const item = state.files.find(function find(file) { return file.path === path; });
    if (!item) {
      state.editingPath = null;
      renderRows(true);
      return;
    }
    const ext = Planner.extOf(item.name);
    let base = raw.trim();
    if (ext && base.toLowerCase().endsWith('.' + ext.toLowerCase())) {
      base = base.slice(0, base.length - ext.length - 1);
    }
    state.overrides = Object.assign({}, state.overrides);
    if (base && base !== Planner.baseNameOf(item.name)) state.overrides[path] = base;
    else delete state.overrides[path];
    state.editingPath = null;
    recompute();
  }

  function syncSelectAll() {
    const total = state.files.length;
    const selected = state.selected.size;
    elements.selectAll.checked = total > 0 && selected === total;
    elements.selectAll.indeterminate = selected > 0 && selected < total;
    elements.selectAll.disabled = total === 0;
  }

  function renderSummary() {
    syncSelectAll();
    const summary = state.summary;
    if (!summary) {
      elements.summary.innerHTML = '';
      elements.runBtn.disabled = true;
      return;
    }
    elements.summary.innerHTML = ''
      + '<span>已选 <b>' + summary.selected + '</b> / ' + summary.total + '</span>'
      + '<span class="sum-div"></span>'
      + '<span class="sum-ok">将重命名 <b>' + summary.rename + '</b></span>'
      + '<span class="sum-div"></span>'
      + '<span class="' + (summary.conflict > 0 ? 'sum-bad' : '') + '">冲突 <b>' + summary.conflict + '</b></span>'
      + (summary.invalid > 0 ? '<span class="sum-div"></span><span class="sum-bad">无效 <b>' + summary.invalid + '</b></span>' : '')
      + '<span class="sum-div"></span>'
      + '<span>无变化 <b>' + summary.unchanged + '</b></span>'
      + (summary.rename > 0 ? '<span class="sum-div"></span><span>' + formatBytes(summary.bytes) + '</span>' : '');
    elements.runBtn.disabled = state.busy || summary.rename === 0;
    $('resetOverrides').hidden = Object.keys(state.overrides).length === 0;
  }

  function updateHistoryButtons() {
    const latest = state.history.find(function find(entry) { return !entry.undone; });
    elements.undoBtn.disabled = state.busy || !latest;
  }

  async function runRename() {
    if (state.busy || !state.summary || state.summary.rename === 0) return;
    const jobs = state.items
      .filter(function executable(item) { return item.selected && item.status === 'ok'; })
      .map(function pair(item) { return { from: item.path, to: item.targetPath }; });
    if (!jobs.length) return;

    clearToasts();
    setBusy(true, '正在重命名', '0 / ' + jobs.length);
    let response;
    try {
      response = await api.execute(jobs);
    } catch (error) {
      toast('重命名请求失败：' + error.message, { tone: 'bad', duration: 7000 });
      return;
    } finally {
      setBusy(false);
    }

    if (!response.ok) {
      toast(response.message || '重命名失败', { tone: 'bad', duration: 7000 });
      if (response.details && response.details.failures && response.details.failures.length) {
        await refreshHistory();
        if (state.folder) await scanFolder(state.folder, { silent: true });
      }
      return;
    }

    toast('已重命名 ' + response.data.count + ' 个文件', {
      action: response.data.entryId ? {
        label: '撤销',
        run: function runUndo() { undoEntry(response.data.entryId); }
      } : null
    });
    await refreshHistory();
    if (state.folder) await scanFolder(state.folder, { silent: true });
  }

  async function undoEntry(id) {
    if (state.busy) return;
    clearToasts();
    setBusy(true, '正在撤销', '');
    let response;
    try {
      response = await api.undo(id);
    } catch (error) {
      toast('撤销请求失败：' + error.message, { tone: 'bad', duration: 7000 });
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      toast(response.message || '撤销失败', { tone: 'bad', duration: 7000 });
      await refreshHistory();
      return;
    }
    toast('已恢复 ' + response.data.count + ' 个文件的原名');
    await refreshHistory();
    if (state.folder) await scanFolder(state.folder, { silent: true });
  }

  async function refreshHistory() {
    let response = null;
    try {
      response = await api.history();
    } catch (error) {
      response = null;
    }
    state.history = response && response.ok ? response.data : [];
    renderHistory();
    updateHistoryButtons();
  }

  function renderHistory() {
    elements.historyCount.textContent = String(state.history.length);
    if (!state.history.length) {
      elements.historyList.innerHTML = '<li class="history-empty">暂无记录</li>';
      return;
    }
    elements.historyList.innerHTML = state.history.map(function item(entry) {
      const sample = entry.sample && entry.sample[0]
        ? escapeHtml(entry.sample[0].from) + ' → ' + escapeHtml(entry.sample[0].to)
        : '';
      const more = entry.count > 1 ? ' +' + (entry.count - 1) : '';
      const tail = entry.undone
        ? '<span class="history-tag">已撤销</span>'
        : '<button class="link-btn history-undo" data-action="undo" data-id="' + escapeAttr(entry.id) + '">撤销</button>';
      return '<li class="history-item' + (entry.undone ? ' is-undone' : '') + '">'
        + '<div class="history-line">'
        + '<span class="history-time">' + formatShortTime(entry.at) + '</span>'
        + '<span class="history-count">' + entry.count + ' 个文件</span>'
        + tail
        + '</div>'
        + '<div class="history-sample" title="' + escapeAttr(sample + more) + '">' + sample + more + '</div>'
        + '</li>';
    }).join('');
  }

  async function loadStartup() {
    try {
      const info = await api.startup();
      if (info.recovery && info.recovery.failures && info.recovery.failures.length) {
        toast('上次中断恢复未完全成功，有 ' + info.recovery.failures.length + ' 个文件需手动处理', { tone: 'bad', duration: 9000 });
      } else if (info.recovery && info.recovery.recovered > 0) {
        toast('已恢复上次中断的 ' + info.recovery.recovered + ' 个文件');
      } else if (info.recoveryError) {
        toast('中断恢复失败：' + info.recoveryError, { tone: 'bad' });
      }
    } catch (error) {
      /* 启动信息读取失败不影响主流程 */
    }
    await refreshHistory();
  }

  function setBusy(flag, label, countText) {
    state.busy = !!flag;
    elements.busy.hidden = !flag;
    elements.busy.classList.toggle('is-indeterminate', !countText);
    elements.busyFill.style.width = '0%';
    if (flag) {
      elements.busyLabel.textContent = label || '正在处理';
      elements.busyCount.textContent = countText || '';
    }
    elements.runBtn.disabled = state.busy || !state.summary || state.summary.rename === 0;
    elements.undoBtn.disabled = state.busy || !state.history.some(function open(entry) { return !entry.undone; });
    $('pickBtn').disabled = state.busy;
    $('recursiveToggle').disabled = state.busy;
    $('typeFilter').disabled = state.busy;
    elements.selectAll.disabled = state.busy || !state.files.length;
  }

  if (api && typeof api.onProgress === 'function') {
    api.onProgress(function progress(data) {
      if (!state.busy || !data || !data.total) return;
      const percent = Math.min(100, Math.round((data.done / data.total) * 100));
      elements.busyFill.style.width = percent + '%';
      elements.busy.classList.remove('is-indeterminate');
      elements.busyCount.textContent = data.done + ' / ' + data.total;
    });
  }

  function clearToasts() {
    elements.toastHolder.innerHTML = '';
  }

  function toast(message, options) {
    const opts = options || {};
    const node = document.createElement('div');
    node.className = 'toast' + (opts.tone === 'bad' ? ' is-bad' : '');
    const text = document.createElement('span');
    text.textContent = message;
    node.appendChild(text);
    if (opts.action && typeof opts.action.run === 'function') {
      const button = document.createElement('button');
      button.className = 'toast-action';
      button.textContent = opts.action.label || '撤销';
      button.addEventListener('click', function run() {
        dismiss();
        opts.action.run();
      });
      node.appendChild(button);
    }
    elements.toastHolder.appendChild(node);
    while (elements.toastHolder.children.length > 3) {
      elements.toastHolder.removeChild(elements.toastHolder.firstElementChild);
    }
    let closed = false;
    function dismiss() {
      if (closed) return;
      closed = true;
      node.classList.add('is-leaving');
      setTimeout(function remove() {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 180);
    }
    setTimeout(dismiss, opts.duration || 3800);
  }

  function syncControls() {
    $('recursiveToggle').checked = state.recursive;
    $('typeFilter').value = state.typeFilter;
    $('sortKey').value = state.sortKey;
    $('startIndex').value = String(state.startIndex);
    $('padWidth').value = String(state.padWidth);
    $('findInput').value = state.find;
    $('replaceInput').value = state.replacement;
    document.querySelectorAll('#sortDirGroup .seg-btn').forEach(function sync(button) {
      button.classList.toggle('is-active', button.dataset.dir === state.sortDir);
    });
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return value + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1000;
    let index = 0;
    while (size >= 1000 && index < units.length - 1) {
      size /= 1000;
      index += 1;
    }
    const digits = size >= 100 ? 0 : 1;
    return size.toFixed(digits) + ' ' + units[index];
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return '—';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return pad(date.getFullYear(), 4) + '-' + pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2)
      + ' ' + pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2);
  }

  function formatShortTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2) + ' ' + pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2);
  }

  function pad(value, width) {
    const text = String(value);
    return text.length >= width ? text : '0'.repeat(width - text.length) + text;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 冒烟测试入口：仅在带 smoke 查询参数加载时暴露，用于自动化渲染核验
  if (new URLSearchParams(window.location.search).has('smoke')) {
    window.__smokeLoadFolder = scanFolder;
  }
})();
