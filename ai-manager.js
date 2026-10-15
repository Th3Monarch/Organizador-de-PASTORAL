const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { once } = require('events');

/* ============================================================
   Gestor de IA local (Ollama) empaquetada dentro de la app.
   La app descarga Ollama una sola vez, lo ejecuta y administra
   los modelos sin que el usuario instale nada aparte.
   ============================================================ */

const OLLAMA_PORT = 11434;
const OLLAMA_HOST = `127.0.0.1:${OLLAMA_PORT}`;
const OLLAMA_URL = `http://${OLLAMA_HOST}`;

let child = null;
let notifyFn = () => {};
let installing = false;
let starting = null;

function setNotifier(fn) { notifyFn = fn; }
function progress(data) { try { notifyFn(data); } catch (e) { /* noop */ } }

function aiDir() { return path.join(app.getPath('userData'), 'ai'); }
function modelsDir() { return path.join(aiDir(), 'models'); }
function serverDir() { return path.join(aiDir(), 'ollama'); }

function ensureDirs() {
  fs.mkdirSync(modelsDir(), { recursive: true });
  fs.mkdirSync(aiDir(), { recursive: true });
}

function zipUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `https://github.com/ollama/ollama/releases/latest/download/ollama-windows-${arch}.zip`;
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return null;
}

function ollamaExe() {
  const direct = path.join(serverDir(), 'ollama.exe');
  if (fs.existsSync(direct)) return direct;
  return findFile(serverDir(), 'ollama.exe');
}

async function ping() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { online: false, models: [] };
    const json = await res.json();
    return { online: true, models: (json.models || []).map((m) => m.name) };
  } catch (e) {
    return { online: false, models: [] };
  }
}

async function isInstalled() {
  return !!ollamaExe();
}

async function status() {
  ensureDirs();
  const installed = await isInstalled();
  const p = await ping();
  return {
    installed,
    running: p.online,
    models: p.models,
    exe: ollamaExe(),
    dataDir: aiDir(),
    port: OLLAMA_PORT
  };
}

/* ---------- Utilidades ---------- */
function freeSpaceGB(dir) {
  try {
    const st = fs.statfsSync(dir);
    return (st.bavail * st.bsize) / 1073741824;
  } catch (e) {
    return null;
  }
}

function looksLikeZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === 'PK';
  } catch (e) {
    return false;
  }
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error((err.trim().split('\n').pop() || ('salida ' + code))));
    });
  });
}

/* ---------- Descarga con progreso, verificación y reintentos ---------- */
async function downloadFile(url, dest, onProgress) {
  const part = dest + '.part';
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) onProgress(0, 0, true);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      const file = fs.createWriteStream(part);
      const reader = res.body.getReader();
      let received = 0;
      let last = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!file.write(Buffer.from(value))) await once(file, 'drain');
          received += value.length;
          const now = Date.now();
          if (now - last > 250) { last = now; onProgress(received, total); }
        }
        await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())));
      } catch (e) {
        file.destroy();
        throw e;
      }
      onProgress(received, total);
      if (!received) throw new Error('La descarga quedó vacía');
      if (total && received !== total) throw new Error(`Descarga incompleta (${received} de ${total} bytes)`);
      fs.renameSync(part, dest);
      return received;
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* noop */ }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('No se pudo completar la descarga: ' + (lastErr && lastErr.message ? lastErr.message : lastErr));
}

/* ---------- Extracción (método .NET con respaldo por tar) ---------- */
async function extractZip(zipPath, dest) {
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${dest.replace(/'/g, "''")}')`
  ].join(' ');
  try {
    await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return;
  } catch (e1) {
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      await runProcess('tar.exe', ['-xf', zipPath, '-C', dest]);
      return;
    } catch (e2) {
      throw new Error('No se pudo extraer el archivo. ' + (e1.message || String(e1)));
    }
  }
}

async function installOllama(force) {
  if (installing) throw new Error('Ya se está instalando');
  installing = true;
  ensureDirs();
  const zipPath = path.join(aiDir(), 'ollama.zip');
  const tmpDir = serverDir() + '.tmp';
  try {
    if (force || !(await isInstalled())) {
      const free = freeSpaceGB(aiDir());
      if (free != null && free < 8) {
        throw new Error(`Espacio insuficiente en disco: se necesitan ~8 GB libres y hay ${free.toFixed(1)} GB.`);
      }

      progress({ phase: 'download', percent: 0, status: 'Descargando el motor de IA...' });
      if (fs.existsSync(zipPath) && looksLikeZip(zipPath)) {
        progress({ phase: 'download', percent: 100, status: 'Usando el paquete ya descargado' });
      } else {
        await downloadFile(zipUrl(), zipPath, (received, total, reset) => {
          const percent = total ? Math.round((received / total) * 100) : 0;
          const mb = (received / 1048576).toFixed(0);
          const totMb = total ? (total / 1048576).toFixed(0) : '?';
          const prefix = reset ? 'Reintentando descarga...' : 'Descargando IA...';
          progress({ phase: 'download', percent, status: `${prefix} ${mb} MB de ${totMb} MB` });
        });
      }

      const free2 = freeSpaceGB(aiDir());
      if (free2 != null && free2 < 6) {
        throw new Error(`Espacio insuficiente para instalar: quedan ${free2.toFixed(1)} GB libres.`);
      }

      if (!looksLikeZip(zipPath)) {
        throw new Error('El archivo descargado está dañado. Revisa tu conexión e inténtalo de nuevo.');
      }

      progress({ phase: 'extract', percent: 99, status: 'Instalando... (esto puede tardar unos minutos)' });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      await extractZip(zipPath, tmpDir);
      if (!findFile(tmpDir, 'ollama.exe')) {
        throw new Error('El paquete descargado no contiene ollama.exe. Inténtalo de nuevo.');
      }
      fs.rmSync(serverDir(), { recursive: true, force: true });
      fs.renameSync(tmpDir, serverDir());
      try { fs.rmSync(zipPath, { force: true }); } catch (e) { /* noop */ }
      progress({ phase: 'extract', percent: 100, status: 'IA instalada' });
    }
    await startServer();
    progress({ phase: 'done', percent: 100, status: 'IA lista' });
    return { ok: true };
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
    progress({ phase: 'error', status: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  } finally {
    installing = false;
  }
}

async function startServer() {
  const st = await ping();
  if (st.online) return { ok: true, reused: true };

  const exe = ollamaExe();
  if (!exe) return { ok: false, error: 'La IA no está instalada' };

  if (starting) return starting;
  starting = (async () => {
    ensureDirs();
    const dir = path.dirname(exe);
    child = spawn(exe, ['serve'], {
      cwd: dir,
      windowsHide: true,
      env: {
        ...process.env,
        OLLAMA_HOST,
        OLLAMA_MODELS: modelsDir()
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('exit', () => { child = null; });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const p = await ping();
      if (p.online) { starting = null; return { ok: true }; }
      await new Promise((r) => setTimeout(r, 800));
    }
    starting = null;
    return { ok: false, error: 'El motor de IA no respondió a tiempo' };
  })();
  return starting;
}

function stopServer() {
  if (child) {
    try { child.kill(); } catch (e) { /* noop */ }
    child = null;
  }
}

async function pullModel(model) {
  if (!model) return { ok: false, error: 'Modelo no especificado' };
  const st = await ping();
  if (!st.online) {
    const s = await startServer();
    if (!s.ok) return s;
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true })
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let received = 0;
    let total = 0;
    let last = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (obj.error) return { ok: false, error: obj.error };
        if (typeof obj.completed === 'number') received = obj.completed;
        if (typeof obj.total === 'number' && obj.total > 0) total = obj.total;
        const now = Date.now();
        if (now - last > 250 || obj.status === 'success') {
          last = now;
          const percent = total ? Math.round((received / total) * 100) : 0;
          const gb = (received / 1073741824).toFixed(2);
          const totGb = total ? (total / 1073741824).toFixed(2) : '?';
          progress({
            phase: 'pull',
            percent,
            status: total ? `Descargando modelo... ${gb} GB de ${totGb} GB` : (obj.status || 'Preparando modelo...')
          });
        }
      }
    }
    progress({ phase: 'pull', percent: 100, status: 'Modelo instalado' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function uninstall() {
  stopServer();
  try {
    if (fs.existsSync(aiDir())) fs.rmSync(aiDir(), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = {
  OLLAMA_URL,
  setNotifier,
  status,
  isInstalled,
  installOllama,
  startServer,
  stopServer,
  pullModel,
  uninstall,
  ping,
  _internals: { findFile, downloadFile, extractZip, zipUrl, freeSpaceGB, looksLikeZip, runProcess }
};
