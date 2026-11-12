import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const source = await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const unavailable of [false, true]) {
    const app = new EventEmitter();
    app.requestSingleInstanceLock = () => true;
    app.whenReady = () => ({ then(fn) { fn(); } });
    app.setAppUserModelId = () => {};
    app.getAppPath = () => '/app';
    app.quit = () => { app.emit('before-quit'); app.didQuit = true; };
    let window, tray;
    class Window extends EventEmitter {
      constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
      isDestroyed() { return false; }
      isMinimized() { return false; }
      show() { this.shown = true; }
      focus() {}
      hide() { this.hidden = true; }
      loadFile() { return Promise.resolve(); }
      loadURL() { return Promise.resolve(); }
    }
    class FakeTray extends EventEmitter {
      constructor() { super(); if (unavailable) throw Error('unsupported'); tray = this; }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(value) { this.menu = value; }
      destroy() {}
    }
    const electron = { app, BrowserWindow: Window, Tray: FakeTray, Menu: { buildFromTemplate: x => x },
      nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {}, resize() { return this; } }) },
      ipcMain: { handle() {}, on() {} }, shell: {} };
    const request = new EventEmitter(); request.destroy = () => {};
    const modules = { electron, 'node:path': path, 'node:http': { get: () => request },
      'node:fs/promises': { readFile: async () => { throw Error('no metadata'); } }, './update-check.cjs': {} };
    const sandbox = { require: name => modules[name], process: { platform, argv: [], env: {} }, URL, Buffer,
      setInterval: () => 1, clearInterval() {}, console: { error() {} } };
    runInNewContext(source, sandbox);
    const close = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit('close', close);
    assert.equal(close.prevented, !unavailable, `${platform}: close behavior`);
    assert.equal(Boolean(window.hidden), !unavailable);
    if (!unavailable) {
      assert.equal(tray.tooltip, 'Ragent · 服务未连接');
      tray.emit('click'); assert.equal(window.shown, true);
      tray.menu[1].click(); assert.equal(window.shown, true);
      app.quit(); assert.equal(app.didQuit, true);
      const quitClose = { prevented: false, preventDefault() { this.prevented = true; } };
      window.emit('close', quitClose); assert.equal(quitClose.prevented, false);
    }
  }
}
console.log('desktop tray: three platforms, restore, quit, and unsupported fallback passed');
