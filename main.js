const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const ai = require('./ai-manager');

let mainWindow = null;
let dataFilePath = null;
const activeChatAborts = new Map();
let allowClose = false;

const EMPTY_DATA = {
  notes: [],
  events: [],
  tasks: [],
  groups: [],
  persons: [],
  chat: [],
  settings: {
    pastorName: '',
    schoolName: '',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2',
    theme: 'light'
  }
};

function ensureDataFile() {
  dataFilePath = path.join(app.getPath('userData'), 'pastoral-data.json');
  if (!fs.existsSync(dataFilePath)) {
    fs.writeFileSync(dataFilePath, JSON.stringify(EMPTY_DATA, null, 2), 'utf8');
  }
}

function readData() {
  try {
    const raw = fs.readFileSync(dataFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_DATA, ...parsed, settings: { ...EMPTY_DATA.settings, ...(parsed.settings || {}) } };
  } catch (err) {
    return JSON.parse(JSON.stringify(EMPTY_DATA));
  }
}

function writeData(data) {
  const tmp = dataFilePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dataFilePath);
  return true;
}

/* ----- Copias de seguridad automáticas ----- */
const MAX_BACKUPS = 30;

function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

function ensureBackupsDir() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rotateBackups(keep) {
  try {
    const dir = backupsDir();
    const files = fs.readdirSync(dir)
      .filter((f) => /^pastoral-.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(keep).forEach((x) => { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* noop */ } });
  } catch (e) { /* noop */ }
}

function createBackup() {
  try {
    if (!dataFilePath || !fs.existsSync(dataFilePath)) return null;
    const dir = ensureBackupsDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(dir, `pastoral-${stamp}.json`);
    fs.copyFileSync(dataFilePath, dest);
    rotateBackups(MAX_BACKUPS);
    return dest;
  } catch (e) {
    return null;
  }
}

function listBackups() {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^pastoral-.*\.json$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function backupDaily() {
  const list = listBackups();
  const today = new Date().toISOString().slice(0, 10);
  if (list.length && new Date(list[0].mtime).toISOString().slice(0, 10) === today) return;
  createBackup();
}

function safeBackupPath(name) {
  const base = path.basename(String(name || ''));
  if (!/^pastoral-.*\.json$/.test(base)) return null;
  const full = path.join(backupsDir(), base);
  if (!full.startsWith(backupsDir())) return null;
  return full;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#f4f6f9',
    title: 'Organizador Pastoral',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    try { mainWindow.webContents.send('app:closing'); } catch (err) { /* noop */ }
    setTimeout(() => {
      allowClose = true;
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); } catch (err) { /* noop */ }
    }, 8000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.pastoral.organizador');
  ensureDataFile();
  backupDaily();

  ai.setNotifier((data) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('ai:progress', data));
  });

  ipcMain.handle('data:load', () => readData());
  ipcMain.handle('data:save', (_evt, data) => writeData(data));
  ipcMain.handle('data:path', () => dataFilePath);
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:confirm-quit', () => {
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return true;
  });
  ipcMain.handle('notify', (_evt, payload) => {
    try {
      if (!Notification.isSupported()) return false;
      const { title, body } = payload || {};
      new Notification({
        title: String(title || 'Organizador Pastoral'),
        body: String(body || ''),
        icon: path.join(__dirname, 'build', 'icon.png')
      }).show();
      return true;
    } catch (e) {
      return false;
    }
  });
  ipcMain.handle('data:reveal', () => {
    shell.showItemInFolder(dataFilePath);
    return true;
  });
  ipcMain.handle('data:export', async (_evt, data) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar respaldo',
      defaultPath: path.join(app.getPath('documents'), `pastoral-backup-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return '';
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
    return res.filePath;
  });

  // ----- Copias de seguridad -----
  ipcMain.handle('backup:list', () => listBackups());
  ipcMain.handle('backup:create', () => {
    const p = createBackup();
    return { ok: !!p, path: p || '' };
  });
  ipcMain.handle('backup:restore', (_evt, name) => {
    try {
      const src = safeBackupPath(name);
      if (!src || !fs.existsSync(src)) return { ok: false, error: 'Copia no encontrada' };
      createBackup();
      fs.copyFileSync(src, dataFilePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('backup:delete', (_evt, name) => {
    try {
      const p = safeBackupPath(name);
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'Copia no encontrada' };
      fs.unlinkSync(p);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  ipcMain.handle('backup:reveal', () => {
    shell.openPath(ensureBackupsDir());
    return true;
  });

  // ----- IA local administrada por la app (Ollama) -----
  ipcMain.handle('ai:manager-status', () => ai.status());
  ipcMain.handle('ai:install', (_evt, force) => ai.installOllama(force));
  ipcMain.handle('ai:start', () => ai.startServer());
  ipcMain.handle('ai:stop', () => { ai.stopServer(); return { ok: true }; });
  ipcMain.handle('ai:pull', (_evt, model) => ai.pullModel(model));
  ipcMain.handle('ai:uninstall', () => ai.uninstall());

  ipcMain.handle('ai:status', async (_evt, url) => {
    const base = (url || ai.OLLAMA_URL).replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { online: false, models: [] };
      const json = await res.json();
      const models = (json.models || []).map((m) => m.name);
      return { online: true, models };
    } catch (err) {
      return { online: false, models: [], error: String(err.message || err) };
    }
  });

  ipcMain.handle('ai:chat', async (evt, payload) => {
    const { url, model, messages, tools, requestId } = payload || {};
    const base = (url || ai.OLLAMA_URL).replace(/\/$/, '');
    let ctrl = null;
    let signal = AbortSignal.timeout(180000);
    if (requestId) {
      ctrl = new AbortController();
      activeChatAborts.set(requestId, ctrl);
      signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    }
    const onDelta = (delta) => { try { evt.sender.send('ai:stream', { requestId, delta }); } catch (e) { /* noop */ } };
    try {
      const apiMessages = (messages || []).map((m) => {
        if (!m || !Array.isArray(m.images) || !m.images.length) return m;
        return { ...m, images: m.images.map((s) => String(s).replace(/^data:[^,]*,/, '')) };
      });
      const body = { model, messages: apiMessages, stream: true };
      if (tools && tools.length) body.tools = tools;
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const txt = await res.text();
        return { ok: false, error: `HTTP ${res.status}: ${txt}` };
      }
      // Ollama emite NDJSON (una línea JSON por fragmento)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      const tool_calls = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          let obj;
          try { obj = JSON.parse(s); } catch (e) { continue; }
          if (obj.error) return { ok: false, error: String(obj.error) };
          const msg = obj.message || {};
          if (msg.content) { content += msg.content; onDelta(msg.content); }
          if (Array.isArray(msg.tool_calls)) tool_calls.push(...msg.tool_calls);
        }
      }
      return { ok: true, content, tool_calls };
    } catch (err) {
      if (ctrl && ctrl.signal.aborted) return { ok: false, canceled: true, error: 'Respuesta detenida por el usuario.' };
      return { ok: false, error: String(err.message || err) };
    } finally {
      if (requestId) activeChatAborts.delete(requestId);
    }
  });

  ipcMain.on('ai:cancel', (_evt, requestId) => {
    const c = activeChatAborts.get(requestId);
    if (c) { try { c.abort(); } catch (e) { /* noop */ } }
  });

  createWindow();

  if (ai.isInstalled()) {
    ai.startServer().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  allowClose = true;
  ai.stopServer();
});
