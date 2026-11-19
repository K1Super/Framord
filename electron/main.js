'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { scanFolder, ScanError } = require('./engine/scanner');
const { Renamer, RenameError } = require('./engine/renamer');

const APP_ID = 'com.framord.app';
const SMOKE = process.argv.includes('--smoke');
const SCREENSHOT_ARG = process.argv.find(function find(arg) { return arg.startsWith('--screenshot='); });
const FIXTURE_ARG = process.argv.find(function find(arg) { return arg.startsWith('--fixture='); });
const RUN_FLOW = process.argv.includes('--flow');

let mainWindow = null;
let renamer = null;
let startupState = null;

app.setAppUserModelId(APP_ID);
app.setName('Framord');
Menu.setApplicationMenu(null);

// 冒烟运行使用独立数据目录，避免污染真实历史记录
if (SMOKE) {
  const smokeData = path.join(__dirname, '..', '.smoke', 'userdata');
  fs.mkdirSync(smokeData, { recursive: true });
  app.setPath('userData', smokeData);
}

async function prepareStartupState() {
  try {
    const recovery = await renamer.recoverPending();
    startupState = { recovery: recovery };
  } catch (error) {
    startupState = { recovery: null, recoveryError: error.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Framord',
    icon: path.join(__dirname, '..', 'assets', 'framord.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#4d4d4d',
      height: 52
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  mainWindow.once('ready-to-show', function show() {
    if (SMOKE && !SCREENSHOT_ARG) return;
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(function deny() {
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', function block(event) {
    event.preventDefault();
  });

  mainWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'index.html'),
    SMOKE ? { query: { smoke: '1' } } : undefined
  );

  if (SMOKE) runSmokeCheck(mainWindow);
}

function registerIpc() {
  ipcMain.handle('dialog:pickFolder', async function pickFolder() {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择照片文件夹',
      properties: ['openDirectory'],
      buttonLabel: '选择'
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fs:scan', async function scan(event, payload) {
    const options = validatePayload(payload);
    try {
      return { ok: true, data: await scanFolder(options) };
    } catch (error) {
      return { ok: false, message: error instanceof ScanError ? error.message : '扫描失败：' + error.message };
    }
  });

  ipcMain.handle('rename:execute', async function execute(event, payload) {
    const items = validatePayload(payload);
    try {
      const result = await renamer.execute(items, function progress(data) {
        if (!event.sender.isDestroyed()) event.sender.send('rename:progress', data);
      });
      return { ok: true, data: result };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RenameError ? error.code : 'UNKNOWN',
        message: error.message || '重命名失败',
        details: error instanceof RenameError ? error.details : null
      };
    }
  });

  ipcMain.handle('history:list', async function historyList() {
    try {
      return { ok: true, data: await renamer.listHistory() };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  ipcMain.handle('history:undo', async function historyUndo(event, payload) {
    const input = validatePayload(payload);
    if (!/^[0-9a-f-]{36}$/i.test(input.id || '')) return { ok: false, message: '撤销记录编号无效' };
    try {
      const result = await renamer.undo(input.id, function progress(data) {
        if (!event.sender.isDestroyed()) event.sender.send('rename:progress', data);
      });
      return { ok: true, data: result };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof RenameError ? error.code : 'UNKNOWN',
        message: error.message || '撤销失败'
      };
    }
  });

  ipcMain.handle('shell:reveal', async function reveal(event, payload) {
    const input = validatePayload(payload);
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
      return { ok: false, message: '路径无效' };
    }
    try {
      const stat = await fs.promises.stat(input.path);
      if (stat.isDirectory()) await shell.openPath(input.path);
      else shell.showItemInFolder(input.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: '路径不存在' };
    }
  });

  ipcMain.handle('fs:resolveDrop', async function resolveDrop(event, payload) {
    const input = validatePayload(payload);
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) {
      return { ok: false, message: '路径无效' };
    }
    try {
      const stat = await fs.promises.stat(input.path);
      return { ok: true, data: { dir: stat.isDirectory() ? input.path : path.dirname(input.path) } };
    } catch (error) {
      return { ok: false, message: '路径不存在' };
    }
  });

  ipcMain.handle('app:startup', function startup() {
    return {
      version: app.getVersion(),
      recovery: startupState ? startupState.recovery : null,
      recoveryError: startupState ? startupState.recoveryError || null : null
    };
  });
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('请求参数无效');
  return payload;
}

async function waitFor(windowContents, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await windowContents.executeJavaScript(expression);
    if (value) return true;
    await new Promise(function wait(resolve) { setTimeout(resolve, 120); });
  }
  return false;
}

async function runSmokeCheck(window) {
  const messages = [];
  window.webContents.on('console-message', function onMessage(event, level, message) {
    if (level && typeof level === 'object') {
      messages.push({ level: typeof level.level === 'number' ? level.level : 3, message: level.message || '' });
      return;
    }
    messages.push({ level: level, message: message });
  });
  window.webContents.on('preload-error', function preloadFailed(event, preloadPath, error) {
    messages.push({ level: 3, message: 'preload: ' + (error && error.message ? error.message : String(error)) });
  });
  window.webContents.on('render-process-gone', function gone(event, details) {
    console.error('RENDERER_GONE', JSON.stringify(details));
    app.exit(1);
  });
  window.webContents.once('did-finish-load', async function loaded() {
    try {
      await new Promise(function wait(resolve) { setTimeout(resolve, 800); });
      if (FIXTURE_ARG) {
        const fixture = path.resolve(FIXTURE_ARG.slice('--fixture='.length));
        await window.webContents.executeJavaScript('window.__smokeLoadFolder(' + JSON.stringify(fixture) + ')');
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const rows = await window.webContents.executeJavaScript("document.querySelectorAll('.row').length");
          if (rows > 0) break;
          await new Promise(function wait(resolve) { setTimeout(resolve, 100); });
        }
        const diagnostic = await window.webContents.executeJavaScript("({ busy: document.getElementById('busy').hidden, rows: document.querySelectorAll('.row').length, summary: document.getElementById('summary').textContent, path: document.getElementById('topPath').textContent })");
        console.log('DIAG', JSON.stringify(diagnostic));
        if (RUN_FLOW) {
          const before = await fs.promises.readdir(fixture);
          await window.webContents.executeJavaScript("document.getElementById('runBtn').click()");
          const renamed = await waitFor(window.webContents, "document.querySelectorAll('.history-item').length > 0", 20000);
          const afterRename = await fs.promises.readdir(fixture);
          await window.webContents.executeJavaScript("document.querySelector('[data-action=\"undo\"]').click()");
          const undone = await waitFor(window.webContents, "document.querySelectorAll('.history-item.is-undone').length > 0", 20000);
          const afterUndo = await fs.promises.readdir(fixture);
          console.log('FLOW', JSON.stringify({ renamed: renamed, undone: undone, before: before, afterRename: afterRename, afterUndo: afterUndo }));
          if (!renamed || !undone) app.exit(1);
        }
        await new Promise(function wait(resolve) { setTimeout(resolve, 500); });
      }
      if (SCREENSHOT_ARG) {
        const target = path.resolve(SCREENSHOT_ARG.slice('--screenshot='.length));
        const image = await window.webContents.capturePage();
        await fs.promises.writeFile(target, image.toPNG());
      }
      const errors = messages.filter(function isError(item) { return item.level >= 2; });
      console.log(JSON.stringify({ ok: errors.length === 0, errors: errors, messages: messages }, null, 2));
      app.exit(errors.length === 0 ? 0 : 1);
    } catch (error) {
      console.error('SMOKE_FAILED', error && error.stack ? error.stack : String(error));
      app.exit(1);
    }
  });
}

app.whenReady().then(async function ready() {
  renamer = new Renamer(path.join(app.getPath('userData'), 'rename-history.json'));
  await prepareStartupState();
  registerIpc();
  createWindow();

  app.on('activate', function reopen() {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function closed() {
  app.quit();
});
