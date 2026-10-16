/* ============================================================
   Organizador Pastoral - lógica de la interfaz
   ============================================================ */

const api = window.pastoral;

const CHAT_MODELS = {
  daily: { model: 'gemma4:12b', label: 'Diario · Gemma 4 12B' },
  deep: { model: 'qwen3.5:9b', label: 'Profundo · Qwen 3.5 9B' }
};

let state = {
  notes: [], events: [], tasks: [], groups: [], persons: [], chat: [],
  settings: {
    pastorName: '', schoolName: '',
    ollamaUrl: 'http://127.0.0.1:11434', theme: 'light', chatMode: 'daily', notify: true, showWelcome: true
  }
};

let ui = {
  view: 'dashboard',
  calRef: new Date(),
  calSelected: toKey(new Date()),
  taskFilter: 'all',
  chatBusy: false,
  chatThinking: null,
  chatTimer: null,
  chatRequestId: null,
  chatCanceled: false,
  streamText: '',
  streamRaf: null,
  attached: [],
  remindersHidden: false,
  searchSel: 0,
  searchItems: [],
  notified: {}
};

let aiMgr = { installed: false, running: false, models: [], exe: null, dataDir: '', port: 11434 };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/* ------------------------------------------------------------
   Render de Markdown (seguro y sin dependencias)
   El texto se escapa antes de aplicar el formato, así que
   nunca se inyecta HTML del modelo.
   ------------------------------------------------------------ */
let mdCodeBlocks = [];

function mdInline(s) {
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, n) => `<code>${esc(mdCodeBlocks[Number(n)] || '')}</code>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => `<img alt="${alt}" src="${/^https?:/i.test(url) ? url : ''}" />`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) => {
    const href = /^(https?:|mailto:)/i.test(url) ? url : '#';
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\n/g, '<br />');
}

function mdListItem(line) {
  const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] };
}

function mdRenderList(lines, start) {
  const first = mdListItem(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const it = mdListItem(lines[i]);
    if (!it || it.indent < baseIndent) break;
    if (it.indent > baseIndent) {
      if (!items.length) break;
      const nested = mdRenderList(lines, i);
      items[items.length - 1].children.push(nested.html);
      i = nested.next;
      continue;
    }
    if (it.ordered !== ordered) break;
    items.push({ text: it.text, children: [] });
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((it) => `<li>${mdInline(esc(it.text))}${it.children.join('')}</li>`).join('');
  return { html: `<${tag}>${body}</${tag}>`, next: i };
}

function mdRenderTable(rows) {
  const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const header = cells(rows[0]);
  const aligns = cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':')) ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
  let html = '<table><thead><tr>';
  header.forEach((c, k) => { html += `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(esc(c))}</th>`; });
  html += '</tr></thead><tbody>';
  for (let r = 2; r < rows.length; r++) {
    const row = cells(rows[r]);
    html += '<tr>';
    header.forEach((_, k) => { html += `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(esc(row[k] || ''))}</td>`; });
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function renderMarkdown(src) {
  if (src == null) return '';
  let text = String(src).replace(/\r\n?/g, '\n');
  mdCodeBlocks = [];
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, c) => {
    const idx = mdCodeBlocks.length;
    mdCodeBlocks.push(c.replace(/\n$/, ''));
    return `\u0000C${idx}\u0000`;
  });

  const lines = text.split('\n');
  const html = [];
  let para = [];
  const flush = () => {
    if (!para.length) return;
    html.push('<p>' + mdInline(esc(para.join('\n'))) + '</p>');
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const codeOnly = line.match(/^\u0000C(\d+)\u0000\s*$/);
    if (codeOnly) {
      flush();
      html.push(`<pre><code>${esc(mdCodeBlocks[Number(codeOnly[1])] || '')}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const lv = h[1].length; html.push(`<h${lv}>${mdInline(esc(h[2]))}</h${lv}>`); continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); html.push('<hr />'); continue; }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;
      html.push('<blockquote>' + mdInline(esc(buf.join('\n'))) + '</blockquote>');
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i++; }
      i--;
      if (rows.length >= 2) { html.push(mdRenderTable(rows)); continue; }
    }

    if (mdListItem(line)) {
      flush();
      const list = mdRenderList(lines, i);
      html.push(list.html);
      i = list.next - 1;
      continue;
    }

    para.push(line);
  }
  flush();
  return html.join('\n');
}

function toKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function fmtDate(key) {
  if (!key) return 'Sin fecha';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ------------------------------------------------------------
   Eventos recurrentes
   ------------------------------------------------------------ */
const REPEAT_LABELS = { none: 'No se repite', weekly: 'Semanal', monthly: 'Mensual' };

function repeatLabel(rep) { return REPEAT_LABELS[rep] || ''; }

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function eventHasRepeat(e) {
  return e && (e.repeat === 'weekly' || e.repeat === 'monthly');
}

function eventOccursOn(e, key) {
  if (!e || !e.date) return false;
  if (!eventHasRepeat(e)) return e.date === key;
  if (key < e.date) return false;
  if (e.repeatUntil && key > e.repeatUntil) return false;
  if (e.repeat === 'weekly') return keyToDate(e.date).getDay() === keyToDate(key).getDay();
  if (e.repeat === 'monthly') return keyToDate(e.date).getDate() === keyToDate(key).getDate();
  return false;
}

function nextOccurrence(e, fromKey) {
  if (!e || !e.date) return null;
  if (!eventHasRepeat(e)) return e.date >= fromKey ? e.date : null;
  let d = keyToDate(e.date >= fromKey ? e.date : fromKey);
  for (let i = 0; i < 750; i++) {
    const key = toKey(d);
    if (e.repeatUntil && key > e.repeatUntil) return null;
    if (eventOccursOn(e, key)) return key;
    d.setDate(d.getDate() + 1);
  }
  return null;
}

/* ------------------------------------------------------------
   Calendario litúrgico (Occidente / rito romano)
   ------------------------------------------------------------ */
const LIT_FIXED = {
  '01-01': 'María Santísima, Madre de Dios',
  '01-06': 'Epifanía del Señor',
  '02-02': 'Presentación del Señor',
  '03-19': 'San José, esposo de la Virgen',
  '03-25': 'Anunciación del Señor',
  '06-24': 'Natividad de San Juan Bautista',
  '06-29': 'San Pedro y San Pablo',
  '08-06': 'Transfiguración del Señor',
  '08-15': 'Asunción de la Virgen',
  '09-08': 'Natividad de la Virgen',
  '10-07': 'Nuestra Señora del Rosario',
  '11-01': 'Todos los Santos',
  '11-02': 'Conmemoración de los Fieles Difuntos',
  '12-08': 'Inmaculada Concepción',
  '12-12': 'Nuestra Señora de Guadalupe',
  '12-25': 'Navidad del Señor'
};

const LIT_COLORS = {
  Adviento: '#6b4fa8', Navidad: '#c9a227', 'Tiempo Ordinario': '#2fae6b',
  Cuaresma: '#6b4fa8', Pascua: '#c9a227', Triduo: '#b23a3a'
};

function addDays(date, n) { const x = new Date(date); x.setDate(x.getDate() + n); return x; }

function computeEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function firstAdvent(year) {
  let d = new Date(year, 11, 25);
  while (d.getDay() !== 0) d.setDate(d.getDate() - 1);
  return addDays(d, -21);
}

function baptismOfLord(year) {
  let off = (7 - new Date(year, 0, 6).getDay()) % 7;
  if (off === 0) off = 7;
  return addDays(new Date(year, 0, 6), off);
}

function liturgicalInfo(dateKey) {
  const date = keyToDate(dateKey);
  const year = date.getFullYear();
  const easter = computeEaster(year);
  const ash = addDays(easter, -46);
  const pentecost = addDays(easter, 49);
  const advent1 = firstAdvent(year);
  const baptism = baptismOfLord(year);
  const mmdd = dateKey.slice(5);

  const movable = {};
  movable[addDays(easter, -7).getTime()] = 'Domingo de Ramos';
  movable[addDays(easter, -3).getTime()] = 'Jueves Santo';
  movable[addDays(easter, -2).getTime()] = 'Viernes Santo';
  movable[easter.getTime()] = 'Domingo de Pascua';
  movable[addDays(easter, 39).getTime()] = 'Ascensión del Señor';
  movable[addDays(easter, 49).getTime()] = 'Pentecostés';
  movable[addDays(easter, 56).getTime()] = 'Santísima Trinidad';
  movable[addDays(easter, 60).getTime()] = 'Corpus Christi';

  let feast = LIT_FIXED[mmdd] || movable[date.getTime()] || '';

  let season;
  if (date >= advent1 && date < new Date(year, 11, 25)) season = 'Adviento';
  else if (date >= new Date(year, 11, 25) || date < baptism) season = 'Navidad';
  else if (date < ash) season = 'Tiempo Ordinario';
  else if (date < addDays(easter, -1)) season = 'Cuaresma';
  else if (date <= pentecost) season = 'Pascua';
  else season = 'Tiempo Ordinario';

  if (date >= addDays(easter, -3) && date < easter) season = 'Triduo';
  if (!feast && date.getDay() === 0) feast = 'Domingo';

  return { season, color: LIT_COLORS[season] || '#888', feast };
}

function nextCelebration(fromKey) {
  const start = keyToDate(fromKey);
  for (let i = 0; i < 400; i++) {
    const d = addDays(start, i);
    const info = liturgicalInfo(toKey(d));
    if (info.feast && info.feast !== 'Domingo') return { date: toKey(d), feast: info.feast };
  }
  return null;
}


function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ------------------------------------------------------------
   Persistencia
   ------------------------------------------------------------ */
async function persist() {
  await api.save(state);
}

function mergeData(data) {
  state = {
    notes: data.notes || [], events: data.events || [], tasks: data.tasks || [],
    groups: data.groups || [], persons: data.persons || [], chat: data.chat || [],
    settings: { ...state.settings, ...(data.settings || {}) }
  };
}

function applyTheme() {
  document.body.classList.toggle('dark', state.settings.theme === 'dark');
}

/* ------------------------------------------------------------
   Navegación
   ------------------------------------------------------------ */
function go(view) {
  ui.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  render();
}

function render() {
  switch (ui.view) {
    case 'dashboard': renderDashboard(); break;
    case 'notes': renderNotes(); break;
    case 'events': renderCalendar(); renderEventsDay(); break;
    case 'tasks': renderTasks(); break;
    case 'community': renderCommunity(); break;
    case 'assistant': renderChat(); refreshAiManager(); break;
    case 'settings': renderSettings(); break;
  }
}

/* ------------------------------------------------------------
   Dashboard
   ------------------------------------------------------------ */
function renderDashboard() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const name = state.settings.pastorName ? `, ${esc(state.settings.pastorName)}` : '';
  $('#greeting').innerHTML = greet + name;
  $('#brand-school').textContent = state.settings.schoolName || 'Pastoral Escolar';
  renderReminders();

  const today = toKey(new Date());
  const upcoming = state.events
    .map((e) => ({ e, date: nextOccurrence(e, today) }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date + (a.e.time || '')).localeCompare(b.date + (b.e.time || '')));
  const pending = state.tasks.filter((t) => !t.done);

  $('#stats').innerHTML = `
    <div class="stat"><div class="n accent">${state.notes.length}</div><div class="l">Ideas y notas</div></div>
    <div class="stat"><div class="n">${upcoming.length}</div><div class="l">Eventos próximos</div></div>
    <div class="stat"><div class="n">${pending.length}</div><div class="l">Tareas pendientes</div></div>
    <div class="stat"><div class="n">${state.persons.length}</div><div class="l">Personas</div></div>`;

  $('#dash-events').innerHTML = upcoming.length ? upcoming.slice(0, 5).map((x) => `
    <div class="list-item" data-open="event" data-id="${x.e.id}">
      <div class="li-main">
        <div class="li-title">${esc(x.e.title)}</div>
        <div class="li-sub">${esc(fmtDate(x.date))}${x.e.time ? ' · ' + esc(x.e.time) : ''}${x.e.location ? ' · ' + esc(x.e.location) : ''}${attendCount(x.e) ? ' · ' + attendCount(x.e) : ''}${eventHasRepeat(x.e) ? ' · ↻ ' + esc(repeatLabel(x.e.repeat)) : ''}</div>
      </div>
      ${x.e.category ? `<span class="pill">${esc(x.e.category)}</span>` : ''}
    </div>`).join('') : `<div class="empty">No hay eventos próximos</div>`;

  $('#dash-tasks').innerHTML = pending.length ? pending.slice(0, 5).map((t) => `
    <div class="list-item" data-open="task" data-id="${t.id}">
      <div class="li-main">
        <div class="li-title">${esc(t.title)}</div>
        <div class="li-sub">${t.due ? esc(fmtDate(t.due)) : 'Sin fecha'} · ${prioLabel(t.priority)}</div>
      </div>
      <span class="pill ${t.priority === 'alta' ? 'red' : t.priority === 'media' ? 'warn' : ''}">${prioLabel(t.priority)}</span>
    </div>`).join('') : `<div class="empty">No hay tareas pendientes</div>`;

  const recentNotes = [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 4);
  $('#dash-notes').innerHTML = recentNotes.length ? recentNotes.map((n) => `
    <div class="list-item" data-open="note" data-id="${n.id}">
      <div class="li-main">
        <div class="li-title">${esc(n.title || 'Sin título')}</div>
        <div class="li-sub">${esc((n.body || '').slice(0, 90))}</div>
      </div>
    </div>`).join('') : `<div class="empty">Todavía no hay notas</div>`;

  renderReminders();
}

function prioLabel(p) {
  return p === 'alta' ? 'Alta' : p === 'baja' ? 'Baja' : 'Media';
}

function attendCount(e) {
  const n = (e.attendance || []).length;
  return n ? `${n} asistente${n === 1 ? '' : 's'}` : '';
}

function renderReminders() {
  const el = $('#dash-reminders');
  if (!el) return;
  if (ui.remindersHidden) { el.classList.add('hidden'); return; }
  const today = toKey(new Date());
  const plusDay = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return toKey(d); };
  const tomorrow = plusDay(1);
  const overdue = state.tasks.filter((t) => !t.done && t.due && t.due < today);
  const dueSoon = state.tasks.filter((t) => !t.done && t.due && (t.due === today || t.due === tomorrow));
  const evToday = state.events.filter((e) => eventOccursOn(e, today));
  const evTomorrow = state.events.filter((e) => eventOccursOn(e, tomorrow));
  if (!overdue.length && !dueSoon.length && !evToday.length && !evTomorrow.length) { el.classList.add('hidden'); return; }
  let rows = '';
  evToday.forEach((e) => { rows += `<div class="rem-item"><span class="dot"></span><span><strong>Hoy:</strong> ${esc(e.title)}${e.time ? ' · ' + esc(e.time) : ''}${e.location ? ' · ' + esc(e.location) : ''}</span></div>`; });
  evTomorrow.forEach((e) => { rows += `<div class="rem-item"><span class="dot"></span><span><strong>Mañana:</strong> ${esc(e.title)}${e.time ? ' · ' + esc(e.time) : ''}</span></div>`; });
  overdue.forEach((t) => { rows += `<div class="rem-item overdue"><span class="dot"></span><span><strong>Vencida:</strong> ${esc(t.title)} (${esc(fmtDate(t.due))})</span></div>`; });
  dueSoon.forEach((t) => { rows += `<div class="rem-item"><span class="dot"></span><span>${esc(t.title)} · vence ${esc(fmtDate(t.due))}</span></div>`; });
  el.innerHTML = `<h3>🔔 Recordatorios <button class="rem-close" id="rem-close" title="Ocultar">✕</button></h3>${rows}`;
  el.classList.remove('hidden');
}

/* ------------------------------------------------------------
   Avisos del sistema (notificaciones de Windows)
   ------------------------------------------------------------ */
function sysNotify(title, body) {
  if (!state.settings.notify) return;
  try { api.notify({ title, body }); } catch (e) { /* noop */ }
}

function checkNotifications() {
  if (!state.settings.notify) return;
  const today = toKey(new Date());
  const now = new Date();

  state.events.forEach((e) => {
    if (!eventOccursOn(e, today) || !e.time) return;
    const [hh, mm] = e.time.split(':').map(Number);
    const dt = new Date();
    dt.setHours(hh || 0, mm || 0, 0, 0);
    const diff = (dt - now) / 60000;
    const k = 'soon:' + e.id + ':' + today;
    if (diff > 0 && diff <= 60 && !ui.notified[k]) {
      ui.notified[k] = true;
      sysNotify('En menos de 1 hora', e.title + (e.location ? ' · ' + e.location : ''));
    }
  });

  const dayKey = 'day:' + today;
  if (ui.notified[dayKey]) return;
  const overdue = state.tasks.filter((t) => !t.done && t.due && t.due < today);
  const dueToday = state.tasks.filter((t) => !t.done && t.due === today);
  const evToday = state.events.filter((e) => eventOccursOn(e, today));
  if (!overdue.length && !dueToday.length && !evToday.length) return;
  const parts = [];
  if (evToday.length) parts.push(evToday.length === 1 ? `Evento: ${evToday[0].title}${evToday[0].time ? ' (' + evToday[0].time + ')' : ''}` : `${evToday.length} eventos hoy`);
  if (dueToday.length) parts.push(dueToday.length === 1 ? `Tarea: ${dueToday[0].title}` : `${dueToday.length} tareas para hoy`);
  if (overdue.length) parts.push(`${overdue.length} tarea(s) vencida(s)`);
  ui.notified[dayKey] = true;
  sysNotify('Agenda de hoy', parts.join(' · '));
}

/* ------------------------------------------------------------
   Notas
   ------------------------------------------------------------ */
function renderNotes() {
  const q = ($('#notes-search').value || '').toLowerCase();
  const tag = $('#notes-tag').value;
  const allTags = [...new Set(state.notes.flatMap((n) => n.tags || []))].sort();
  const sel = $('#notes-tag');
  sel.innerHTML = `<option value="">Todas las etiquetas</option>` +
    allTags.map((t) => `<option value="${esc(t)}"${t === tag ? ' selected' : ''}>${esc(t)}</option>`).join('');

  let list = [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (q) list = list.filter((n) => (n.title + ' ' + n.body).toLowerCase().includes(q));
  if (tag) list = list.filter((n) => (n.tags || []).includes(tag));

  $('#notes-grid').innerHTML = list.length ? list.map((n) => `
    <div class="card" data-open="note" data-id="${n.id}">
      <h3>${esc(n.title || 'Sin título')}</h3>
      <p>${esc((n.body || '').slice(0, 200))}</p>
      <div style="margin-top:10px">${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No hay notas que coincidan</div>`;
}

const NOTE_TEMPLATES = {
  meeting: {
    title: 'Reunión de pastoral', tags: 'reunión',
    body: 'Fecha:\nAsistentes:\n\nTemas tratados:\n- \n\nAcuerdos:\n- \n\nPróximos pasos:\n- '
  },
  person: {
    title: 'Ficha de persona', tags: 'ficha',
    body: 'Nombre:\nRol:\nGrupo:\nContacto:\n\nSituación / acompañamiento:\n\nObservaciones:\n'
  },
  acta: {
    title: 'Acta de reunión', tags: 'acta',
    body: 'Fecha:\nHora:\nLugar:\nAsistentes:\n\nOrden del día:\n1. \n\nDesarrollo:\n\nAcuerdos:\n- \n\nFirmas:\n'
  },
  retreat: {
    title: 'Planificación de retiro', tags: 'retiro',
    body: 'Tema:\nFecha:\nLugar:\nDestinatarios:\n\nObjetivos:\n- \n\nCronograma:\n- Bienvenida:\n- Dinámica:\n- Reflexión:\n- Oración:\n- Cierre:\n\nMateriales:\nResponsables:\n'
  }
};

function openNote(id, templateId, prefill) {
  const n = state.notes.find((x) => x.id === id);
  const tpl = (!n && !prefill && templateId) ? NOTE_TEMPLATES[templateId] : null;
  const start = prefill || (tpl ? { title: tpl.title, body: tpl.body, tags: (tpl.tags || '').split(',').map((s) => s.trim()).filter(Boolean) } : null);
  openModal({
    title: n ? 'Editar nota' : 'Nueva nota',
    fields: [
      { key: 'title', label: 'Título', type: 'text', placeholder: 'Título de la idea' },
      { key: 'body', label: 'Contenido', type: 'textarea', placeholder: 'Escribe aquí...' },
      { key: 'tags', label: 'Etiquetas (separadas por coma)', type: 'text', placeholder: 'oración, retiro, campaña' }
    ],
    values: n ? { ...n, tags: (n.tags || []).join(', ') }
      : start ? { title: start.title || '', body: start.body || '', tags: Array.isArray(start.tags) ? start.tags.join(', ') : (start.tags || '') }
      : {},
    onSave: async (v) => {
      const tags = (v.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      const now = new Date().toISOString();
      if (n) Object.assign(n, { title: v.title, body: v.body, tags, updatedAt: now });
      else state.notes.push({ id: uid(), title: v.title, body: v.body, tags, createdAt: now, updatedAt: now });
      await persist(); render();
    },
    onDelete: n ? async () => {
      state.notes = state.notes.filter((x) => x.id !== id);
      await persist(); render();
    } : null
  });
}

function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve((input.files && input.files[0]) || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function parseNoteJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/```\s*$/, '').trim();
  const norm = (o) => ({
    title: String(o.title || 'Nota desde imagen').trim().slice(0, 120),
    body: String(o.body || o.content || '').trim(),
    tags: Array.isArray(o.tags) ? o.tags.map((x) => String(x).trim()).filter(Boolean) : []
  });
  try { return norm(JSON.parse(t)); } catch (e) { /* noop */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return norm(JSON.parse(m[0])); } catch (e) { /* noop */ } }
  return { title: 'Nota desde imagen', body: t, tags: [] };
}

async function noteFromImage() {
  if (!aiReady()) { toast('Primero activa la IA local'); go('settings'); return; }
  if (!modelInstalled(currentChatModel())) { toast('El modelo de este modo no está descargado. Instálalo en Ajustes → IA local.'); go('settings'); return; }
  const file = await pickImageFile();
  if (!file) return;
  const btn = $('#notes-image');
  if (btn) btn.disabled = true;
  toast('Analizando la imagen…');
  try {
    const dataUrl = await prepareImage(file);
    const system = {
      role: 'system',
      content: 'Eres un asistente que digitaliza documentos para una app de pastoral escolar. Observa la imagen y devuelve ÚNICAMENTE un objeto JSON válido, sin comentarios ni bloques de código, con las claves: "title" (título breve y descriptivo), "body" (contenido completo en Markdown, respetando títulos, listas, fechas y nombres), "tags" (array de 1 a 5 etiquetas en minúsculas). No inventes información que no aparezca en la imagen.'
    };
    const user = { role: 'user', content: 'Convierte el contenido de esta imagen en una nota.', images: [dataUrl] };
    const res = await api.aiChat({ url: state.settings.ollamaUrl, model: currentChatModel(), messages: [system, user] });
    if (!res || !res.ok) { toast('No se pudo analizar la imagen' + (res && res.error ? ': ' + res.error : '')); return; }
    openNote(null, null, parseNoteJson(res.content));
    toast('Revisa y guarda la nota');
  } catch (e) {
    toast('Error al procesar la imagen');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------------------------------------
   Eventos
   ------------------------------------------------------------ */
function renderCalendar() {
  const ref = ui.calRef;
  const year = ref.getFullYear(), month = ref.getMonth();
  const title = new Date(year, month, 1).toLocaleDateString('es', { month: 'long', year: 'numeric' });
  $('#cal-title').textContent = title.charAt(0).toUpperCase() + title.slice(1);

  const first = new Date(year, month, 1);
  let startOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const todayKey = toKey(new Date());
  let html = '';

  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = toKey(d);
    const evs = state.events.filter((e) => eventOccursOn(e, key)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const lit = liturgicalInfo(key);
    const classes = ['cal-day'];
    if (d.getMonth() !== month) classes.push('other');
    if (key === todayKey) classes.push('today');
    if (key === ui.calSelected) classes.push('selected');
    if (lit.feast) classes.push('feast');
    const litTitle = lit.feast ? `${lit.feast} · ${lit.season}` : lit.season;
    const evHtml = evs.slice(0, 3).map((e) => `<div class="ev">${eventHasRepeat(e) ? '↻ ' : ''}${e.time ? esc(e.time) + ' ' : ''}${esc(e.title)}</div>`).join('');
    const more = evs.length > 3 ? `<div class="ev more">+${evs.length - 3} más</div>` : '';
    html += `<div class="${classes.join(' ')}" data-day="${key}" style="--lit-color:${lit.color}" title="${esc(litTitle)}"><div class="d">${d.getDate()}</div>${evHtml}${more}</div>`;
  }
  $('#calendar').innerHTML = html;
  renderLitBanner();
}

function renderLitBanner() {
  const el = $('#lit-banner');
  if (!el) return;
  const today = toKey(new Date());
  const info = liturgicalInfo(today);
  const next = nextCelebration(addDays(keyToDate(today), 1));
  let html = `<span class="lit-dot" style="background:${info.color}"></span>`;
  html += `<span class="lit-season">${esc(info.season)}</span>`;
  if (info.feast && info.feast !== 'Domingo') html += `<span>· ${esc(info.feast)}</span>`;
  if (next) html += `<span class="lit-next">Próxima celebración: <b>${esc(next.feast)}</b> (${esc(fmtDate(next.date))})</span>`;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function renderEventsDay() {
  const key = ui.calSelected;
  const lit = liturgicalInfo(key);
  $('#events-day-title').textContent = 'Eventos · ' + fmtDate(key) + ' — ' + lit.season + (lit.feast && lit.feast !== 'Domingo' ? ' · ' + lit.feast : '');
  const q = ($('#events-search').value || '').toLowerCase();
  let list = state.events.filter((e) => eventOccursOn(e, key)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (q) list = list.filter((e) => (e.title + ' ' + (e.description || '')).toLowerCase().includes(q));
  $('#events-day').innerHTML = list.length ? list.map((e) => `
    <div class="list-item" data-open="event" data-id="${e.id}">
      <span class="pill date">${e.time ? esc(e.time) : 'Todo el día'}</span>
      <div class="li-main">
        <div class="li-title">${esc(e.title)}</div>
        <div class="li-sub">${esc(e.location || e.description || '')}${attendCount(e) ? (e.location || e.description ? ' · ' : '') + attendCount(e) : ''}${eventHasRepeat(e) ? ' · ↻ ' + esc(repeatLabel(e.repeat)) : ''}</div>
      </div>
      ${e.category ? `<span class="pill">${esc(e.category)}</span>` : ''}
    </div>`).join('') : `<div class="empty">No hay eventos este día. Haz clic en "+ Nuevo evento" o en un día del calendario.</div>`;
}

function openEvent(id, defaultDate) {
  const e = state.events.find((x) => x.id === id);
  openModal({
    title: e ? 'Editar evento' : 'Nuevo evento',
    fields: [
      { key: 'title', label: 'Título', type: 'text', placeholder: 'Ej: Retiro de primaria' },
      { key: 'date', label: 'Fecha', type: 'date' },
      { key: 'time', label: 'Hora', type: 'time' },
      { key: 'location', label: 'Lugar', type: 'text', placeholder: 'Ej: Capilla' },
      { key: 'category', label: 'Categoría', type: 'select', options: ['', 'Misa', 'Retiro', 'Reunión', 'Campaña', 'Formación', 'Convivencia', 'Otro'] },
      { key: 'repeat', label: 'Repetición', type: 'select', options: [
        { value: 'none', label: 'No se repite' },
        { value: 'weekly', label: 'Cada semana' },
        { value: 'monthly', label: 'Cada mes' }
      ] },
      { key: 'repeatUntil', label: 'Repetir hasta (opcional)', type: 'date' },
      { key: 'description', label: 'Descripción', type: 'textarea', placeholder: 'Detalles del evento...' },
      { key: 'attendance', label: 'Asistencia', type: 'people' }
    ],
    values: e ? { ...e, repeat: e.repeat || 'none', attendance: e.attendance || [] }
      : { date: defaultDate || ui.calSelected, repeat: 'none', attendance: [] },
    onSave: async (v) => {
      if (e) Object.assign(e, v);
      else state.events.push({ id: uid(), ...v });
      await persist(); render();
    },
    onDelete: e ? async () => {
      state.events = state.events.filter((x) => x.id !== id);
      await persist(); render();
    } : null
  });
}

/* ------------------------------------------------------------
   Tareas
   ------------------------------------------------------------ */
function renderTasks() {
  const q = ($('#tasks-search').value || '').toLowerCase();
  let list = [...state.tasks];
  if (ui.taskFilter === 'pending') list = list.filter((t) => !t.done);
  if (ui.taskFilter === 'done') list = list.filter((t) => t.done);
  if (q) list = list.filter((t) => t.title.toLowerCase().includes(q));
  list.sort((a, b) => (a.done - b.done) || ((a.due || '9999') .localeCompare(b.due || '9999')));

  $('#tasks-list').innerHTML = list.length ? list.map((t) => `
    <div class="list-item">
      <input type="checkbox" data-toggle="${t.id}" ${t.done ? 'checked' : ''} style="width:18px;height:18px;cursor:pointer" />
      <div class="li-main" data-open="task" data-id="${t.id}">
        <div class="li-title" style="${t.done ? 'text-decoration:line-through;opacity:.55' : ''}">${esc(t.title)}</div>
        <div class="li-sub">${t.due ? esc(fmtDate(t.due)) : 'Sin fecha'}${t.notes ? ' · ' + esc(t.notes.slice(0, 60)) : ''}</div>
      </div>
      <span class="pill ${t.priority === 'alta' ? 'red' : t.priority === 'media' ? 'warn' : ''}">${prioLabel(t.priority)}</span>
    </div>`).join('') : `<div class="empty">No hay tareas aquí</div>`;
}

function openTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  openModal({
    title: t ? 'Editar tarea' : 'Nueva tarea',
    fields: [
      { key: 'title', label: 'Tarea', type: 'text', placeholder: '¿Qué hay que hacer?' },
      { key: 'due', label: 'Fecha límite', type: 'date' },
      { key: 'priority', label: 'Prioridad', type: 'select', options: ['baja', 'media', 'alta'] },
      { key: 'notes', label: 'Notas', type: 'textarea', placeholder: 'Detalles...' }
    ],
    values: t || { priority: 'media' },
    onSave: async (v) => {
      if (t) Object.assign(t, v);
      else state.tasks.push({ id: uid(), ...v, done: false, createdAt: new Date().toISOString() });
      await persist(); render();
    },
    onDelete: t ? async () => {
      state.tasks = state.tasks.filter((x) => x.id !== id);
      await persist(); render();
    } : null
  });
}

/* ------------------------------------------------------------
   Comunidad
   ------------------------------------------------------------ */
function renderCommunity() {
  $('#groups-grid').innerHTML = state.groups.length ? state.groups.map((g) => `
    <div class="card" data-open="group" data-id="${g.id}">
      <h3>${esc(g.name)}</h3>
      <p>${esc(g.description || 'Sin descripción')}</p>
      <div style="margin-top:10px" class="muted">${g.leader ? 'Coordina: ' + esc(g.leader) : ''}</div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No hay grupos</div>`;

  $('#persons-grid').innerHTML = state.persons.length ? state.persons.map((p) => `
    <div class="card" data-open="person" data-id="${p.id}">
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.role || '')}</p>
      <div style="margin-top:10px">${p.group ? `<span class="tag">${esc(p.group)}</span>` : ''}</div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No hay personas</div>`;
}

function openGroup(id) {
  const g = state.groups.find((x) => x.id === id);
  openModal({
    title: g ? 'Editar grupo' : 'Nuevo grupo',
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', placeholder: 'Ej: Pastoral Juvenil' },
      { key: 'leader', label: 'Coordinador/a', type: 'text' },
      { key: 'description', label: 'Descripción', type: 'textarea' }
    ],
    values: g || {},
    onSave: async (v) => {
      if (g) Object.assign(g, v);
      else state.groups.push({ id: uid(), ...v });
      await persist(); render();
    },
    onDelete: g ? async () => {
      state.groups = state.groups.filter((x) => x.id !== id);
      await persist(); render();
    } : null
  });
}

function openPerson(id) {
  const p = state.persons.find((x) => x.id === id);
  openModal({
    title: p ? 'Editar persona' : 'Nueva persona',
    fields: [
      { key: 'name', label: 'Nombre', type: 'text' },
      { key: 'role', label: 'Rol', type: 'text', placeholder: 'Ej: Docente, Alumno, Catequista' },
      { key: 'group', label: 'Grupo', type: 'text' },
      { key: 'contact', label: 'Contacto', type: 'text', placeholder: 'Correo o teléfono' },
      { key: 'notes', label: 'Notas', type: 'textarea' }
    ],
    values: p || {},
    onSave: async (v) => {
      if (p) Object.assign(p, v);
      else state.persons.push({ id: uid(), ...v });
      await persist(); render();
    },
    onDelete: p ? async () => {
      state.persons = state.persons.filter((x) => x.id !== id);
      await persist(); render();
    } : null
  });
}

/* ------------------------------------------------------------
   Herramientas para IA (Function Calling)
   ------------------------------------------------------------ */
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Crear una nueva idea o nota en el organizador pastoral.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título de la nota/idea' },
          body: { type: 'string', description: 'Contenido o texto de la nota' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas separadas (ej. retiro, oración)' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Crear un nuevo evento en la agenda pastoral.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD (obligatorio)' },
          time: { type: 'string', description: 'Hora en formato HH:MM (opcional)' },
          location: { type: 'string', description: 'Lugar del evento' },
          category: { type: 'string', description: 'Categoría (Misa, Retiro, Reunión, Campaña, Formación, Convivencia, Otro)' },
          repeat: { type: 'string', enum: ['none', 'weekly', 'monthly'], description: 'Repetición del evento (por defecto none)' },
          repeatUntil: { type: 'string', description: 'Fecha final de la repetición YYYY-MM-DD (opcional)' },
          description: { type: 'string', description: 'Descripción o detalles del evento' }
        },
        required: ['title', 'date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Crear una nueva tarea pendiente.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          due: { type: 'string', description: 'Fecha límite YYYY-MM-DD (opcional)' },
          priority: { type: 'string', enum: ['baja', 'media', 'alta'], description: 'Prioridad (por defecto media)' },
          notes: { type: 'string', description: 'Notas o detalles de la tarea' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_group',
      description: 'Crear un nuevo grupo de pastoral.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          leader: { type: 'string', description: 'Coordinador/a del grupo' },
          description: { type: 'string' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_person',
      description: 'Registrar una persona en la comunidad pastoral.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', description: 'Rol (Docente, Alumno, Catequista, etc.)' },
          group: { type: 'string', description: 'Grupo al que pertenece' },
          contact: { type: 'string', description: 'Contacto (teléfono/correo)' },
          notes: { type: 'string' }
        },
        required: ['name']
      }
    }
  }
];
function aiReady() {
  return aiMgr.running && (aiMgr.models || []).length > 0;
}

function currentChatModel() {
  return CHAT_MODELS[state.settings.chatMode === 'deep' ? 'deep' : 'daily'].model;
}

function modelInstalled(name) {
  return (aiMgr.models || []).includes(name);
}

async function callModel(messages, requestId) {
  return await api.aiChat({ url: state.settings.ollamaUrl, model: currentChatModel(), messages, tools: AI_TOOLS, requestId });
}

async function refreshAiManager() {
  try { aiMgr = await api.aiManagerStatus(); } catch (e) { /* noop */ }
  updateChatModeUi();
  updateAiUi();
  renderAiModels();
}

function updateChatModeUi() {
  const sel = $('#chat-mode');
  if (sel) sel.value = state.settings.chatMode === 'deep' ? 'deep' : 'daily';
}

function updateAiUi() {
  const chip = $('#ai-chip');
  const chat = $('#chat-box');
  const setup = $('#ai-setup');
  const engineStep = $('#step-engine');
  const modelStep = $('#step-model');
  const installed = aiMgr.installed;
  const running = aiMgr.running;
  const hasModel = (aiMgr.models || []).length > 0;
  const ready = running && hasModel;
  const selectedReady = ready && modelInstalled(currentChatModel());

  chat.classList.toggle('hidden', !ready);
  setup.classList.toggle('hidden', ready);
  const modeSel = $('#chat-mode');
  if (modeSel) modeSel.classList.toggle('hidden', !ready);

  if (selectedReady) { chip.className = 'pill ok'; chip.textContent = '● IA lista'; }
  else if (ready) { chip.className = 'pill warn'; chip.textContent = '● Falta el modelo elegido'; }
  else if (running) { chip.className = 'pill warn'; chip.textContent = '● Falta el modelo'; }
  else if (installed) { chip.className = 'pill warn'; chip.textContent = '● IA detenida'; }
  else { chip.className = 'pill red'; chip.textContent = '● IA no instalada'; }

  engineStep.classList.toggle('done', installed);
  $('#step-engine-desc').textContent = installed ? 'Instalado' : 'Pendiente';
  $('#btn-install').textContent = installed ? 'Reparar' : 'Instalar';

  modelStep.classList.toggle('done', hasModel);
  $('#btn-pull').disabled = !installed;
  const setPull = $('#set-ai-pull');
  if (setPull) setPull.disabled = !installed;
}

function setAiStatusText(text) {
  ['#ai-progress-text', '#set-ai-progress'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = text;
  });
}

function setBar(id, percent) {
  const bar = $('#' + id);
  if (!bar) return;
  bar.classList.remove('hidden');
  const fill = bar.querySelector('.bar-fill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function hideBars() {
  ['bar-engine', 'bar-model', 'bar-model-set'].forEach((id) => {
    const bar = $('#' + id);
    if (bar) bar.classList.add('hidden');
  });
}

function handleAiProgress(d) {
  setAiStatusText(d.status || '');
  const badge = $('#ai-badge');
  if (d.phase === 'download' || d.phase === 'extract') {
    setBar('bar-engine', d.percent || 0);
    if (badge) { badge.className = 'ai-badge busy'; badge.textContent = '● Instalando IA...'; }
  } else if (d.phase === 'pull') {
    setBar('bar-model', d.percent || 0);
    setBar('bar-model-set', d.percent || 0);
    if (badge) { badge.className = 'ai-badge busy'; badge.textContent = '● Bajando modelo...'; }
  } else if (d.phase === 'done') {
    hideBars();
    refreshAiManager(); checkAi();
  } else if (d.phase === 'error') {
    hideBars();
    toast(d.status || 'Error al preparar la IA');
    refreshAiManager();
  }
}

async function installAi(force) {
  const btn = $('#btn-install');
  if (btn) btn.disabled = true;
  const btnPull = $('#btn-pull');
  if (btnPull) btnPull.disabled = true;
  setAiStatusText('Iniciando instalación...');
  const res = await api.aiInstall(force);
  if (btn) btn.disabled = false;
  await refreshAiManager();
  await checkAi();
  if (res.ok) toast('Motor de IA instalado');
  else toast('Error: ' + res.error);
}

async function pullModel(selectEl, buttonEl, progressEl) {
  const select = selectEl || $('#model-choice');
  const button = buttonEl || $('#btn-pull');
  const model = select && select.value;
  if (!model || !model.trim()) { toast('Elige un modelo'); return; }
  if (button) button.disabled = true;
  const progressText = progressEl || $('#ai-progress-text');
  if (progressText) progressText.textContent = 'Iniciando descarga del modelo...';
  const res = await api.aiPull(model);
  hideBars();
  if (!res.ok) { if (button) button.disabled = false; toast('Error: ' + res.error); await refreshAiManager(); return; }
  await refreshAiManager();
  await checkAi();
  toast('Modelo listo');
}

function modelLabel(name) {
  const known = {
    'gemma4:12b': 'Gemma 4 12B — chat diario',
    'qwen3.5:9b': 'Qwen 3.5 9B — chat profundo',
    'llama3.2': 'Llama 3.2 3B — ligero'
  };
  return known[name] || name;
}

function renderAiModels() {
  const wrap = $('#set-ai-models');
  if (!wrap) return;
  const models = aiMgr.models || [];
  if (!models.length) {
    wrap.innerHTML = '<div class="empty">Todavía no hay modelos descargados. Instala el motor y descarga el que prefieras.</div>';
  } else {
    wrap.innerHTML = models.map((m) => `
      <div class="list-item" style="cursor:default">
        <div class="li-main">
          <div class="li-title">${esc(modelLabel(m))}</div>
          <div class="li-sub">${esc(m)}</div>
        </div>
        <button class="btn danger" data-delmodel="${esc(m)}">Borrar</button>
      </div>`).join('');
  }
  const sel = $('#set-model-choice');
  if (sel) {
    Array.from(sel.options).forEach((opt) => {
      const base = opt.dataset.base || opt.textContent.replace(/ · descargado$/, '');
      opt.dataset.base = base;
      opt.textContent = base + (models.includes(opt.value) ? ' · descargado' : '');
    });
  }
}

async function deleteAiModel(model) {
  if (!model) return;
  if (!confirm('¿Borrar el modelo "' + model + '"? Podrás volver a descargarlo cuando quieras.')) return;
  const res = await api.aiDelete(model);
  if (!res.ok) { toast('Error: ' + res.error); return; }
  await refreshAiManager();
  await checkAi();
  toast('Modelo borrado');
}

function thinkingHTML() {
  const t = ui.chatThinking;
  if (!t) return '';
  const secs = Math.floor((Date.now() - t.startedAt) / 1000);
  const label = t.stage === 'connecting' ? 'Conectando con el servicio'
    : t.stage === 'tools' ? 'Preparando acciones'
    : t.stage === 'writing' ? 'Redactando la respuesta'
    : t.stage === 'stopping' ? 'Deteniendo'
    : 'Pensando';
  const time = secs >= 3 ? ` <span class="thinking-time">${secs} s</span>` : '';
  const hint = secs >= 15
    ? '<span class="thinking-hint">Sigue trabajando: puede tardar hasta un minuto. Si quieres, pulsa «Detener».</span>'
    : '';
  return `<div class="thinking-row"><span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span><span class="thinking-label">${label}…${time}</span></div>${hint}`;
}

function streamInnerHTML() {
  const text = ui.streamText || '';
  if (!text) return thinkingHTML();
  let inner = renderMarkdown(text);
  if (inner.endsWith('</p>')) inner = inner.slice(0, -4) + '<span class="stream-cursor"></span></p>';
  else inner += '<span class="stream-cursor"></span>';
  return `<div class="md stream-md">${inner}</div>`;
}

function renderStreamBubble() {
  const el = document.getElementById('chat-streaming');
  if (!el) { renderChat(); return; }
  el.className = 'msg assistant ' + (ui.streamText ? 'streaming' : 'thinking');
  el.innerHTML = streamInnerHTML();
  const log = $('#chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function scheduleStreamRender() {
  if (ui.streamRaf) return;
  ui.streamRaf = requestAnimationFrame(() => { ui.streamRaf = null; renderStreamBubble(); });
}

function handleAiStream(d) {
  if (!ui.chatBusy || !d || d.requestId !== ui.chatRequestId) return;
  if (d.delta) {
    ui.streamText = (ui.streamText || '') + d.delta;
    scheduleStreamRender();
  }
}

function startThinking() {
  ui.chatCanceled = false;
  ui.streamText = '';
  ui.chatThinking = { stage: 'connecting', startedAt: Date.now() };
  if (ui.chatTimer) clearInterval(ui.chatTimer);
  ui.chatTimer = setInterval(renderStreamBubble, 1000);
  renderChat();
}

function setThinkingStage(stage) {
  if (!ui.chatThinking) ui.chatThinking = { startedAt: Date.now() };
  ui.chatThinking.stage = stage;
  renderStreamBubble();
}

function stopThinking() {
  ui.chatThinking = null;
  ui.streamText = '';
  if (ui.chatTimer) { clearInterval(ui.chatTimer); ui.chatTimer = null; }
}

function setChatBusy(busy) {
  const send = $('#chat-send');
  const stop = $('#chat-stop');
  const attach = $('#chat-attach');
  if (send) { send.disabled = busy; send.textContent = busy ? 'Enviando…' : 'Enviar'; }
  if (stop) stop.classList.toggle('hidden', !busy);
  if (attach) attach.disabled = busy;
}

function renderChat() {
  const empty = 'Conversa con tu asistente local. Prueba una sugerencia debajo.';
  let lastAssistant = -1;
  for (let i = state.chat.length - 1; i >= 0; i--) { if (state.chat[i].role === 'assistant') { lastAssistant = i; break; } }
  const busy = ui.chatBusy || !!ui.chatThinking || !!ui.streamText;
  const bubbles = state.chat.map((m, i) => {
    if (m.role === 'user') {
      const imgs = (m.images || []).map((src) => `<img class="msg-img" src="${esc(src)}" alt="Imagen adjunta" />`).join('');
      const imgWrap = imgs ? `<div class="msg-imgs">${imgs}</div>` : '';
      const txt = m.content ? `<div class="msg-text">${esc(m.content)}</div>` : '';
      return `<div class="msg user">${imgWrap}${txt}</div>`;
    }
    const actions = `<div class="msg-actions">
        <button class="msg-action" type="button" data-copy="${i}" title="Copiar respuesta">📋 Copiar</button>
        ${i === lastAssistant && !busy ? `<button class="msg-action" type="button" data-regen="${i}" title="Generar otra respuesta">↻ Rehacer</button>` : ''}
      </div>`;
    return `<div class="msg assistant"><div class="md">${renderMarkdown(m.content)}</div>${actions}</div>`;
  });
  if (ui.chatThinking || ui.streamText) {
    bubbles.push(`<div id="chat-streaming" class="msg assistant ${ui.streamText ? 'streaming' : 'thinking'}">${streamInnerHTML()}</div>`);
  }
  $('#chat-log').innerHTML = bubbles.length ? bubbles.join('') : `<div class="empty">${esc(empty)}</div>`;
  $('#chat-suggest').classList.toggle('hidden', state.chat.length > 0 || !!ui.chatThinking || !!ui.streamText);
  renderAttachments();
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  try {
    await navigator.clipboard.writeText(value);
    toast('Copiado al portapapeles');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copiado al portapapeles');
    } catch (e2) {
      toast('No se pudo copiar');
    }
  }
}

const TOOL_RUNNERS = {
  create_note: (a) => {
    if (!a.title) throw new Error('Falta el título de la nota. Pídelo antes de crearla.');
    const now = new Date().toISOString();
    const tags = Array.isArray(a.tags) ? a.tags.map((s) => String(s).trim()).filter(Boolean) : [];
    const note = { id: uid(), title: String(a.title).trim(), body: (a.body || '').trim(), tags, createdAt: now, updatedAt: now };
    state.notes.push(note);
    return { kind: 'nota', label: note.title, id: note.id };
  },
  create_event: (a) => {
    if (!a.title) throw new Error('Falta el título del evento. Pídelo antes de crearlo.');
    if (!a.date) throw new Error('Falta la fecha del evento (formato YYYY-MM-DD). Pregúntala antes de crearlo.');
    const ev = {
      id: uid(), title: String(a.title).trim(), date: String(a.date).trim(),
      time: (a.time || '').trim(), location: (a.location || '').trim(),
      category: (a.category || '').trim(), description: (a.description || '').trim(),
      repeat: ['weekly', 'monthly'].includes(a.repeat) ? a.repeat : 'none',
      repeatUntil: (a.repeatUntil || '').trim(), attendance: []
    };
    state.events.push(ev);
    return { kind: 'evento', label: ev.title, id: ev.id };
  },
  create_task: (a) => {
    if (!a.title) throw new Error('Falta el título de la tarea. Pídelo antes de crearla.');
    const task = {
      id: uid(), title: String(a.title).trim(), due: (a.due || '').trim(),
      priority: ['baja', 'media', 'alta'].includes(a.priority) ? a.priority : 'media',
      notes: (a.notes || '').trim(), done: false, createdAt: new Date().toISOString()
    };
    state.tasks.push(task);
    return { kind: 'tarea', label: task.title, id: task.id };
  },
  create_group: (a) => {
    if (!a.name) throw new Error('Falta el nombre del grupo. Pídelo antes de crearlo.');
    const g = { id: uid(), name: String(a.name).trim(), leader: (a.leader || '').trim(), description: (a.description || '').trim() };
    state.groups.push(g);
    return { kind: 'grupo', label: g.name, id: g.id };
  },
  create_person: (a) => {
    if (!a.name) throw new Error('Falta el nombre de la persona. Pídelo antes de registrarla.');
    const p = { id: uid(), name: String(a.name).trim(), role: (a.role || '').trim(), group: (a.group || '').trim(), contact: (a.contact || '').trim(), notes: (a.notes || '').trim() };
    state.persons.push(p);
    return { kind: 'persona', label: p.name, id: p.id };
  }
};

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

async function runToolCalls(toolCalls) {
  const messages = [];
  const done = [];
  for (const call of toolCalls) {
    const name = call.function && call.function.name;
    const args = parseToolArgs(call.function && call.function.arguments);
    const runner = TOOL_RUNNERS[name];
    let result;
    if (!runner) {
      result = { ok: false, error: 'Herramienta desconocida: ' + name };
    } else {
      try {
        const info = runner(args);
        result = { ok: true, ...info };
        done.push(info);
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }
    }
    const toolMsg = { role: 'tool', tool_name: name, content: JSON.stringify(result) };
    if (call.id) toolMsg.tool_call_id = call.id;
    messages.push(toolMsg);
  }
  if (done.length) await persist();
  return { messages, done };
}

function buildContextSummary() {
  const today = toKey(new Date());
  const parts = [];
  parts.push(`Hoy es ${today}.`);
  const lit = liturgicalInfo(today);
  parts.push(`Tiempo litúrgico: ${lit.season}${lit.feast && lit.feast !== 'Domingo' ? ' (' + lit.feast + ')' : ''}.`);
  parts.push(`Total: ${state.notes.length} notas, ${state.events.length} eventos, ${state.tasks.filter((t) => !t.done).length} tareas pendientes, ${state.groups.length} grupos, ${state.persons.length} personas.`);
  const upcoming = state.events
    .map((e) => ({ e, date: nextOccurrence(e, today) }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date + (a.e.time || '')).localeCompare(b.date + (b.e.time || ''))).slice(0, 8);
  if (upcoming.length) parts.push('Próximos eventos: ' + upcoming.map((x) => `${x.e.title} (${x.date}${x.e.time ? ' ' + x.e.time : ''})`).join('; ') + '.');
  const pending = state.tasks.filter((t) => !t.done)
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 8);
  if (pending.length) parts.push('Tareas pendientes: ' + pending.map((t) => `${t.title}${t.due ? ' (' + t.due + ')' : ''}`).join('; ') + '.');
  if (state.groups.length) parts.push('Grupos: ' + state.groups.map((g) => g.name).slice(0, 12).join(', ') + '.');
  const notes = [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  if (notes.length) parts.push('Últimas notas: ' + notes.map((n) => n.title || 'Sin título').join('; ') + '.');
  if (state.persons.length) parts.push('Personas: ' + state.persons.map((p) => p.name + (p.role ? ` (${p.role})` : '')).slice(0, 15).join(', ') + '.');
  return parts.join('\n');
}

/* ------------------------------------------------------------
   Adjuntos de imagen (visión)
   ------------------------------------------------------------ */
const MAX_ATTACH = 4;
const MAX_SIDE = 1536;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('No se pudo leer la imagen'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Imagen no válida'));
    img.src = src;
  });
}

async function prepareImage(file) {
  const raw = await readFileAsDataURL(file);
  try {
    const img = await loadImage(raw);
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    if (scale >= 1 && raw.length < 700000) return raw;
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return raw;
  }
}

async function addAttachment(file) {
  if (!file || !/^image\//.test(file.type || '')) return;
  if (ui.attached.length >= MAX_ATTACH) { toast('Máximo ' + MAX_ATTACH + ' imágenes por mensaje'); return; }
  try {
    const url = await prepareImage(file);
    ui.attached.push(url);
    renderAttachments();
  } catch (e) {
    toast('No se pudo añadir la imagen');
  }
}

function renderAttachments() {
  const box = $('#chat-attach-preview');
  if (!box) return;
  if (!ui.attached.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = ui.attached.map((src, i) => `
    <div class="attach-thumb">
      <img src="${esc(src)}" alt="Adjunto ${i + 1}" />
      <button class="attach-remove" type="button" data-attach-remove="${i}" title="Quitar">✕</button>
    </div>`).join('');
}

function clearAttachments() {
  ui.attached = [];
  renderAttachments();
}

function buildSystemPrompt() {
  return {
    role: 'system',
    content: `Eres el asistente de la pastoral de un colegio${state.settings.schoolName ? ' (' + state.settings.schoolName + ')' : ''}${state.settings.pastorName ? ', responsable ' + state.settings.pastorName : ''}. ` +
      `Ayudas a organizar ideas, eventos, retiros, campañas, tareas, grupos y personas. Responde en español, de forma práctica, cálida y concisa. ` +
      `Escribe tus respuestas en formato Markdown (negritas, listas, títulos con #, tablas cuando aporten claridad): la app lo mostrará con estilo. ` +
      `El usuario puede adjuntar imágenes: si recibes una, descríbela e interprétala con atención (textos, listas, fechas, personas, horarios) y úsala para ayudarle. ` +
      `Eres católico, con sensibilidad hacia la espiritualidad dominicana. Usa lenguaje respetuoso, teológicamente correcto y acorde a los valores del Evangelio.\n` +
      `Puedes CREAR elementos (notas, eventos, tareas, grupos y personas) con las herramientas disponibles. ` +
      `Cuando el usuario pida añadir, crear o registrar algo, llama a la herramienta correspondiente. Si falta un dato imprescindible (por ejemplo la fecha de un evento), pídelo antes de crearlo. ` +
      `No inventes datos. Cuando ya tengas la información suficiente, actúa directamente.\n` +
      `REGLA ABSOLUTA PARA ORACIONES: Si el usuario te pide escribir una oración, oración cristiana, rezar, bendición, reflexión, acto penitencial, invocación, plegaria, jaculatoria, palabra de acogida, ofrenda, acción de gracias, consagración o cualquier texto para un momento de oración, DEBES generar el texto completo de la oración. ` +
      `Nunca respondas "¿Te gustaría que te escriba una oración...?" o preguntes datos adicionales si el usuario ya dio información sobre para qué la necesita. ` +
      `Escribe oraciones completas, bien estructuradas y listas para rezar en comunidad. ` +
      `Incluye elementos apropiados: invocación (Gloria al Padre...), cuerpo con peticiones, posible respuesta (R/.), conclusión (Por nuestro Señor Jesucristo...) y firma o nombre según corresponda. ` +
      `Para celebraciones dominicanas, recuerda la espiritualidad de Santo Domingo de Guzmán: predicación, estudio, oración, comunidad y la búsqueda de la Verdad (Veritas). Usa términos propios de la vida dominicana cuando sea oportuno. ` +
      `Ten en cuenta el tiempo litúrgico (Adviento, Navidad, Cuaresma, Semana Santa, Pascua, Pentecostés, Tiempo Ordinario) cuando sea relevante.\n` +
      `Contexto actual de la app:\n${buildContextSummary()}`
  };
}

async function runAssistantTurn() {
  ui.chatBusy = true;
  ui.chatRequestId = uid();
  startThinking();
  setChatBusy(true);

  await persist();

  const messages = [buildSystemPrompt(), ...state.chat.slice(-12)];
  const actions = [];
  let finalContent = '';

  try {
    for (let step = 0; step < 6; step++) {
      ui.streamText = '';
      if (step > 0) setThinkingStage('thinking');
      const res = await callModel(messages, ui.chatRequestId);
      if (res.canceled) { ui.chatCanceled = true; break; }
      if (!res.ok) {
        finalContent = `⚠ No se pudo conectar con la IA local.\n\n${res.error}\n\nRevisa que el motor esté en marcha (Ajustes / IA local).`;
        break;
      }
      const calls = res.tool_calls || [];
      if (!calls.length) { finalContent = ((res.content || ui.streamText) || '').trim(); break; }
      setThinkingStage('tools');
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls });
      const handled = await runToolCalls(calls);
      messages.push(...handled.messages);
      handled.done.forEach((d) => actions.push(d));
      if (handled.done.length) toast('Creado: ' + handled.done.map((d) => `${d.kind} «${d.label}»`).join(', '));
      if (step === 5) finalContent = 'He terminado las acciones solicitadas.';
    }
    if (ui.chatCanceled) { toast('Respuesta detenida'); }
    else if (finalContent) state.chat.push({ role: 'assistant', content: finalContent });
    else if (actions.length) state.chat.push({ role: 'assistant', content: 'Hecho. ' + actions.map((d) => `Creé la ${d.kind} «${d.label}»`).join(', ') + '.' });
    await persist();
  } catch (err) {
    state.chat.push({ role: 'assistant', content: `Error: ${String(err.message || err)}` });
    await persist();
    toast('Error al enviar mensaje');
  } finally {
    ui.chatRequestId = null;
    stopThinking();
    setChatBusy(false);
    ui.chatBusy = false;
    renderChat();
    render();
  }
}

async function sendChat(text) {
  const hasImages = ui.attached.length > 0;
  if (ui.chatBusy || (!text.trim() && !hasImages)) return;
  if (!aiReady()) {
    toast('Primero activa la IA local');
    go('settings');
    return;
  }
  if (!modelInstalled(currentChatModel())) {
    toast('El modelo de este modo no está descargado. Instálalo en Ajustes → IA local.');
    go('settings');
    return;
  }
  const userMsg = { role: 'user', content: text.trim() };
  if (hasImages) userMsg.images = ui.attached.slice();
  state.chat.push(userMsg);
  clearAttachments();
  await runAssistantTurn();
}

async function regenerate() {
  if (ui.chatBusy) return;
  if (!aiReady()) {
    toast('Primero activa la IA local');
    go('settings');
    return;
  }
  if (!modelInstalled(currentChatModel())) {
    toast('El modelo de este modo no está descargado. Instálalo en Ajustes → IA local.');
    go('settings');
    return;
  }
  let idx = -1;
  for (let i = state.chat.length - 1; i >= 0; i--) { if (state.chat[i].role === 'assistant') { idx = i; break; } }
  if (idx === -1) { toast('No hay respuesta que rehacer'); return; }
  state.chat.splice(idx);
  await runAssistantTurn();
}

function weeklySummary() {
  if (!aiReady()) { toast('Primero activa la IA en el asistente'); return; }
  go('assistant');
  sendChat('Hazme un resumen de mi semana pastoral: indica los eventos próximos y qué tareas debería priorizar, con sugerencias prácticas y breves.');
}

/* ------------------------------------------------------------
   Ajustes
   ------------------------------------------------------------ */
async function renderSettings() {
  $('#set-pastor').value = state.settings.pastorName || '';
  $('#set-school').value = state.settings.schoolName || '';
  $('#set-theme').value = state.settings.theme || 'light';
  const notifyEl = $('#set-notify');
  if (notifyEl) notifyEl.checked = state.settings.notify !== false;
  const welcomeEl = $('#set-welcome');
  if (welcomeEl) welcomeEl.checked = state.settings.showWelcome !== false;
  try { $('#set-datapath').textContent = await api.dataPath(); } catch (e) { /* noop */ }
  try { $('#set-version').textContent = 'Versión ' + await api.appVersion(); } catch (e) { /* noop */ }
  await refreshAiManager();
  const st = $('#set-ai-state');
  if (aiMgr.running && (aiMgr.models || []).length) { st.className = 'pill ok'; st.textContent = 'Lista · ' + aiMgr.models.length + ' modelo(s)'; }
  else if (aiMgr.running) { st.className = 'pill warn'; st.textContent = 'Encendida, sin modelos'; }
  else if (aiMgr.installed) { st.className = 'pill warn'; st.textContent = 'Detenida'; }
  else { st.className = 'pill red'; st.textContent = 'No instalada'; }
  $('#set-ai-dir').textContent = 'Carpeta de IA: ' + (aiMgr.dataDir || '');
  renderBackups();
}


function fmtBackupName(name) {
  const m = String(name).match(/pastoral-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return name;
  return `${m[1]} · ${m[2]}:${m[3]}:${m[4]}`;
}

function fmtSize(bytes) {
  if (!bytes) return '0 KB';
  return bytes < 1024 * 1024 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

async function restoreBackup(name) {
  if (!confirm('¿Restaurar esta copia? Los datos actuales se reemplazarán (se guardará antes una copia de seguridad).')) return;
  const res = await api.backupRestore(name);
  if (!res.ok) { toast('Error: ' + res.error); return; }
  mergeData(await api.load());
  applyTheme();
  render();
  toast('Datos restaurados');
}

async function deleteBackup(name) {
  if (!confirm('¿Eliminar esta copia de seguridad?')) return;
  const res = await api.backupDelete(name);
  if (!res.ok) { toast('Error: ' + res.error); return; }
  renderBackups();
}

async function renderBackups() {
  let list = [];
  try { list = await api.backupList(); } catch (e) { /* noop */ }
  $('#backup-list').innerHTML = list.length ? list.slice(0, 12).map((b) => `
    <div class="backup-item">
      <div class="bi-main">
        <div class="bi-title">${esc(fmtBackupName(b.name))}</div>
        <div class="bi-sub">${esc(fmtSize(b.size))}</div>
      </div>
      <button class="btn small" data-restore="${esc(b.name)}">Restaurar</button>
      <button class="icon-btn" data-delbackup="${esc(b.name)}" title="Eliminar">✕</button>
    </div>`).join('') : `<div class="empty">Todavía no hay copias</div>`;
}

async function checkAi() {
  const badge = $('#ai-badge');
  const st = await api.aiStatus(state.settings.ollamaUrl);
  if (st.online) {
    badge.className = 'ai-badge online';
    badge.textContent = '● IA conectada';
    return st;
  }
  badge.className = 'ai-badge offline';
  badge.textContent = '● IA desconectada';
  return st;
}

/* ------------------------------------------------------------
   Modal genérico
   ------------------------------------------------------------ */
let modalCtx = null;

function openModal(cfg) {
  modalCtx = cfg;
  $('#modal-title').textContent = cfg.title;
  const form = $('#modal-form');
  const v = cfg.values || {};
  form.innerHTML = cfg.fields.map((f) => {
    const val = v[f.key] == null ? '' : v[f.key];
    if (f.type === 'textarea') {
      return `<label class="field"><span>${esc(f.label)}</span><textarea name="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea></label>`;
    }
    if (f.type === 'select') {
      return `<label class="field"><span>${esc(f.label)}</span><select name="${f.key}">` +
        f.options.map((o) => {
          const ov = (o && typeof o === 'object') ? o.value : o;
          const ol = (o && typeof o === 'object') ? (o.label || '—') : (o || '—');
          return `<option value="${esc(ov)}"${String(val) === String(ov) ? ' selected' : ''}>${esc(ol)}</option>`;
        }).join('') +
        `</select></label>`;
    }
    if (f.type === 'people') {
      const selected = Array.isArray(val) ? val : [];
      const opts = state.persons.length
        ? state.persons.map((p) => `<label class="attend-item"><input type="checkbox" data-people="${esc(f.key)}" value="${esc(p.id)}"${selected.includes(p.id) ? ' checked' : ''} /> ${esc(p.name)}${p.role ? ' · ' + esc(p.role) : ''}</label>`).join('')
        : `<div class="muted">Aún no hay personas. Añádelas en "Comunidad".</div>`;
      return `<div class="field"><span>${esc(f.label)}</span><div class="attend-list">${opts}</div></div>`;
    }
    return `<label class="field"><span>${esc(f.label)}</span><input type="${f.type}" name="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" /></label>`;
  }).join('');
  $('#modal-delete').classList.toggle('hidden', !cfg.onDelete);
  $('#modal').classList.remove('hidden');
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  modalCtx = null;
}

async function saveModal() {
  if (!modalCtx) return;
  const form = $('#modal-form');
  const values = {};
  modalCtx.fields.forEach((f) => {
    if (f.type === 'people') {
      values[f.key] = $$(`#modal-form [data-people="${f.key}"]:checked`).map((i) => i.value);
      return;
    }
    const el = form.querySelector(`[name="${f.key}"]`);
    values[f.key] = el ? el.value.trim() : '';
  });
  const required = modalCtx.fields[0];
  if (required && !values[required.key]) { toast('El campo "' + required.label + '" es obligatorio'); return; }
  await modalCtx.onSave(values);
  closeModal();
  toast('Guardado');
}

/* ------------------------------------------------------------
   Búsqueda global
   ------------------------------------------------------------ */
function buildSearchIndex() {
  const items = [];
  state.notes.forEach((n) => items.push({
    type: 'note', id: n.id, ico: '💡', title: n.title || 'Sin título',
    sub: (n.body || '').slice(0, 80),
    text: [n.title, n.body, (n.tags || []).join(' ')].join(' ').toLowerCase()
  }));
  state.events.forEach((e) => items.push({
    type: 'event', id: e.id, ico: '📅', title: e.title || 'Evento',
    sub: [fmtDate(e.date), e.time, e.location].filter(Boolean).join(' · '),
    text: [e.title, e.location, e.description, e.date].join(' ').toLowerCase()
  }));
  state.tasks.forEach((t) => items.push({
    type: 'task', id: t.id, ico: '✅', title: t.title || 'Tarea',
    sub: [t.due ? fmtDate(t.due) : '', t.done ? 'completada' : ''].filter(Boolean).join(' · '),
    text: [t.title, t.notes].join(' ').toLowerCase()
  }));
  state.groups.forEach((g) => items.push({
    type: 'group', id: g.id, ico: '👥', title: g.name || 'Grupo',
    sub: [g.leader, g.description].filter(Boolean).join(' · '),
    text: [g.name, g.leader, g.description].join(' ').toLowerCase()
  }));
  state.persons.forEach((p) => items.push({
    type: 'person', id: p.id, ico: '👤', title: p.name || 'Persona',
    sub: [p.role, p.group, p.contact].filter(Boolean).join(' · '),
    text: [p.name, p.role, p.group, p.contact, p.notes].join(' ').toLowerCase()
  }));
  return items;
}

function openSearch() {
  ui.searchItems = buildSearchIndex();
  ui.searchSel = 0;
  $('#search').classList.remove('hidden');
  $('#search-input').value = '';
  renderSearchResults('');
  setTimeout(() => $('#search-input').focus(), 30);
}

function closeSearch() {
  $('#search').classList.add('hidden');
}

function renderSearchResults(q) {
  const query = (q || '').trim().toLowerCase();
  let items = ui.searchItems;
  if (query) items = items.filter((it) => it.text.includes(query) || it.title.toLowerCase().includes(query));
  if (query) items = items.slice(0, 40); else items = items.slice(0, 12);
  ui.searchSel = Math.min(ui.searchSel, Math.max(0, items.length - 1));
  ui.searchShown = items;
  $('#search-results').innerHTML = items.length ? items.map((it, i) => `
    <div class="search-result${i === ui.searchSel ? ' active' : ''}" data-sr="${i}">
      <span class="sr-ico">${it.ico}</span>
      <div class="sr-main">
        <div class="sr-title">${esc(it.title)}</div>
        ${it.sub ? `<div class="sr-sub">${esc(it.sub)}</div>` : ''}
      </div>
    </div>`).join('') : `<div class="search-empty">Sin resultados</div>`;
}

function openSearchResult(it) {
  if (!it) return;
  closeSearch();
  if (it.type === 'note') openNote(it.id);
  if (it.type === 'event') openEvent(it.id);
  if (it.type === 'task') openTask(it.id);
  if (it.type === 'group') openGroup(it.id);
  if (it.type === 'person') openPerson(it.id);
}

function moveSearch(delta) {
  const items = ui.searchShown || [];
  if (!items.length) return;
  ui.searchSel = (ui.searchSel + delta + items.length) % items.length;
  renderSearchResults($('#search-input').value);
  const active = $('#search-results .search-result.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------
   Exportar .ics / PDF
   ------------------------------------------------------------ */
function icsEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }

function icsEndTime(time) {
  if (!time) return '10:00';
  const [h, m] = time.split(':').map(Number);
  const d = new Date(2000, 0, 1, h || 0, m || 0);
  d.setHours(d.getHours() + 1);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function exportIcs() {
  const evs = [...state.events].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  if (!evs.length) { toast('No hay eventos para exportar'); return; }
  const pad = (n) => String(n).padStart(2, '0');
  const dt = (date, time) => {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = (time || '09:00').split(':').map(Number);
    return `${y}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Organizador Pastoral//ES', 'CALSCALE:GREGORIAN'];
  evs.forEach((e) => {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + e.id + '@organizador-pastoral');
    lines.push('DTSTAMP:' + stamp);
    lines.push('DTSTART:' + dt(e.date, e.time));
    lines.push('DTEND:' + dt(e.date, icsEndTime(e.time)));
    lines.push('SUMMARY:' + icsEsc(e.title || 'Evento'));
    if (e.location) lines.push('LOCATION:' + icsEsc(e.location));
    if (e.description) lines.push('DESCRIPTION:' + icsEsc(e.description));
    if (e.category) lines.push('CATEGORIES:' + icsEsc(e.category));
    if (eventHasRepeat(e)) {
      let rule = 'FREQ=' + (e.repeat === 'weekly' ? 'WEEKLY' : 'MONTHLY');
      if (e.repeatUntil) rule += ';UNTIL=' + e.repeatUntil.replace(/-/g, '') + 'T235959Z';
      lines.push('RRULE:' + rule);
    }
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  downloadFile('agenda-pastoral.ics', lines.join('\r\n'), 'text/calendar;charset=utf-8');
  toast('Archivo .ics exportado');
}

function printAgenda() {
  const area = $('#print-area');
  const school = state.settings.schoolName || 'Pastoral Escolar';
  const evs = [...state.events].filter((e) => e.date).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  let html = `<h1>${esc(school)} — Agenda pastoral</h1>`;
  html += `<p>${esc(new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>`;
  html += '<h2>Eventos</h2>';
  html += evs.length ? evs.map((e) => `<div class="pr-item"><span class="pr-date">${esc(fmtDate(e.date))}${e.time ? ' · ' + esc(e.time) : ''}</span> — ${esc(e.title)}${e.location ? ' · ' + esc(e.location) : ''}${e.category ? ' · ' + esc(e.category) : ''}${eventHasRepeat(e) ? ' · ↻ ' + esc(repeatLabel(e.repeat)) : ''}</div>`).join('') : '<p>No hay eventos.</p>';
  const pending = state.tasks.filter((t) => !t.done);
  html += '<h2>Tareas pendientes</h2>';
  html += pending.length ? pending.map((t) => `<div class="pr-item">${esc(t.title)}${t.due ? ' · ' + esc(fmtDate(t.due)) : ''} ${t.priority ? '(' + esc(prioLabel(t.priority)) + ')' : ''}</div>`).join('') : '<p>Sin tareas pendientes.</p>';
  area.innerHTML = html;
  window.print();
}

/* ------------------------------------------------------------
   Exportar notas y comunidad (PDF / CSV)
   ------------------------------------------------------------ */
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '\ufeff' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
}

function printNotes() {
  const notes = [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (!notes.length) { toast('No hay notas para exportar'); return; }
  const school = state.settings.schoolName || 'Pastoral Escolar';
  let html = `<h1>${esc(school)} — Ideas y notas</h1>`;
  html += `<p>${esc(new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }))} · ${notes.length} nota(s)</p>`;
  html += notes.map((n) => {
    const tags = (n.tags || []).length ? `<p class="pr-tags">${n.tags.map((t) => esc(t)).join(' · ')}</p>` : '';
    return `<div class="pr-note"><h2>${esc(n.title || 'Sin título')}</h2>${tags}<div class="pr-body">${esc(n.body || '').replace(/\n/g, '<br />')}</div></div>`;
  }).join('');
  $('#print-area').innerHTML = html;
  window.print();
}

function exportNotesCsv() {
  if (!state.notes.length) { toast('No hay notas para exportar'); return; }
  const rows = [['Título', 'Etiquetas', 'Contenido', 'Creada', 'Actualizada']];
  [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).forEach((n) => {
    rows.push([n.title || '', (n.tags || []).join(' '), n.body || '', n.createdAt || '', n.updatedAt || '']);
  });
  downloadFile('notas-pastoral.csv', toCsv(rows), 'text/csv;charset=utf-8');
  toast('Notas exportadas a CSV');
}

function printCommunity() {
  const school = state.settings.schoolName || 'Pastoral Escolar';
  let html = `<h1>${esc(school)} — Comunidad</h1>`;
  html += `<p>${esc(new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>`;
  html += '<h2>Grupos</h2>';
  html += state.groups.length ? state.groups.map((g) => `<div class="pr-item"><span class="pr-date">${esc(g.name)}</span>${g.leader ? ' · ' + esc(g.leader) : ''}${g.description ? ' — ' + esc(g.description) : ''}</div>`).join('') : '<p>No hay grupos.</p>';
  html += '<h2>Personas</h2>';
  html += state.persons.length ? state.persons.map((p) => `<div class="pr-item"><span class="pr-date">${esc(p.name)}</span>${p.role ? ' · ' + esc(p.role) : ''}${p.group ? ' · ' + esc(p.group) : ''}${p.contact ? ' · ' + esc(p.contact) : ''}${p.notes ? ' — ' + esc(p.notes) : ''}</div>`).join('') : '<p>No hay personas.</p>';
  $('#print-area').innerHTML = html;
  window.print();
}

function exportCommunityCsv() {
  if (!state.groups.length && !state.persons.length) { toast('No hay datos de comunidad para exportar'); return; }
  const rows = [['Tipo', 'Nombre', 'Rol', 'Grupo', 'Contacto', 'Notas', 'Coordinador/a', 'Descripción']];
  state.groups.forEach((g) => rows.push(['Grupo', g.name || '', '', '', '', '', g.leader || '', g.description || '']));
  state.persons.forEach((p) => rows.push(['Persona', p.name || '', p.role || '', p.group || '', p.contact || '', p.notes || '', '', '']));
  downloadFile('comunidad-pastoral.csv', toCsv(rows), 'text/csv;charset=utf-8');
  toast('Comunidad exportada a CSV');
}

/* ------------------------------------------------------------
   Pantalla de inicio (bienvenida) y de ida (despedida)
   ------------------------------------------------------------ */
const WELCOME_VERSES = [
  { t: 'El Señor es mi pastor; nada me faltará.', r: 'Salmo 23, 1' },
  { t: 'Todo lo puedo en Cristo que me fortalece.', r: 'Filipenses 4, 13' },
  { t: 'La paz os dejo, mi paz os doy.', r: 'Juan 14, 27' },
  { t: 'Venid a mí todos los que estáis cansados y agobiados, y yo os aliviaré.', r: 'Mateo 11, 28' },
  { t: 'Donde dos o tres están reunidos en mi nombre, allí estoy yo en medio de ellos.', r: 'Mateo 18, 20' },
  { t: 'El que permanece en mí y yo en él, ese da mucho fruto.', r: 'Juan 15, 5' },
  { t: 'Confía en el Señor de todo corazón y no te apoyes en tu propia inteligencia.', r: 'Proverbios 3, 5' },
  { t: 'Sed fuertes y valientes; no temáis, porque el Señor tu Dios está contigo.', r: 'Josué 1, 9' },
  { t: 'Lámpara es tu palabra para mis pasos, luz en mi sendero.', r: 'Salmo 119, 105' },
  { t: 'La alegría del Señor es vuestra fuerza.', r: 'Nehemías 8, 10' },
  { t: 'Permaneced en mi amor.', r: 'Juan 15, 9' },
  { t: 'Bienaventurados los que trabajan por la paz, porque serán llamados hijos de Dios.', r: 'Mateo 5, 9' }
];

const GOODBYE_VERSES = [
  { t: 'Id por todo el mundo y anunciad el Evangelio.', r: 'Marcos 16, 15' },
  { t: 'Vete en paz.', r: 'Lucas 7, 50' },
  { t: 'La paz de Dios, que supera todo entendimiento, guardará vuestros corazones.', r: 'Filipenses 4, 7' },
  { t: 'El Señor te bendiga y te guarde.', r: 'Números 6, 24' },
  { t: 'Que el Dios de la esperanza os llene de toda alegría y paz.', r: 'Romanos 15, 13' },
  { t: 'Encomienda al Señor tu camino; confía en él, y él actuará.', r: 'Salmo 37, 5' }
];

function dailyIndex(len, salt) {
  const key = toKey(new Date()) + (salt || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 100000;
  return h % len;
}

function pickVerse(list, salt) { return list[dailyIndex(list.length, salt)]; }

function renderVerse(verse, textSel, refSel) {
  const t = $(textSel), r = $(refSel);
  if (t) t.textContent = '«' + verse.t + '»';
  if (r) r.textContent = '— ' + verse.r;
}

function showWelcome() {
  const el = $('#welcome');
  if (!el) return;
  if (state.settings.showWelcome === false) { el.classList.add('hidden'); return; }
  const now = new Date();
  $('#welcome-school').textContent = state.settings.schoolName || 'Pastoral Escolar';
  const name = state.settings.pastorName ? ', ' + state.settings.pastorName : '';
  const hour = now.getHours();
  const greet = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  $('#welcome-greet').textContent = `${greet}${name}. La paz sea contigo.`;
  const dateEl = $('#welcome-date');
  dateEl.textContent = now.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const lit = liturgicalInfo(toKey(now));
  const litEl = $('#welcome-lit');
  litEl.textContent = lit.season + (lit.feast && lit.feast !== 'Domingo' ? ' · ' + lit.feast : '');
  litEl.style.borderLeftColor = lit.color;
  litEl.classList.remove('hidden');
  renderVerse(pickVerse(WELCOME_VERSES, 'welcome'), '#welcome-verse-text', '#welcome-verse-ref');
  $('#welcome-dont-show').checked = false;
  el.classList.remove('hidden', 'closing');
}

function hideWelcome() {
  const el = $('#welcome');
  if (!el || el.classList.contains('hidden') || el.classList.contains('closing')) return;
  if ($('#welcome-dont-show').checked) {
    state.settings.showWelcome = false;
    const s = $('#set-welcome');
    if (s) s.checked = false;
    persist();
  }
  el.classList.add('closing');
  setTimeout(() => el.classList.add('hidden'), 460);
}

let closingInProgress = false;
function showGoodbye() {
  if (closingInProgress) return;
  closingInProgress = true;
  const el = $('#goodbye');
  const v = pickVerse(GOODBYE_VERSES, 'goodbye');
  renderVerse(v, '#goodbye-verse-text', '#goodbye-verse-ref');
  const sub = $('#goodbye-sub');
  if (sub) sub.textContent = 'Gracias por tu labor' + (state.settings.pastorName ? ', ' + state.settings.pastorName : '') + '. Que el Señor te acompañe y te guarde.';
  if (!el) { api.confirmQuit(); return; }
  el.classList.remove('hidden');
  const bar = $('#goodbye-bar');
  if (bar) { bar.classList.remove('run'); void bar.offsetWidth; bar.classList.add('run'); }
  setTimeout(() => api.confirmQuit(), 6200);
}

/* ------------------------------------------------------------
   Eventos globales de la interfaz
   ------------------------------------------------------------ */
function useAiExample(text) {
  go('assistant');
  const ready = aiMgr.running && (aiMgr.models || []).length > 0;
  if (!ready) { toast('Primero activa la IA en el asistente'); return; }
  setTimeout(() => sendChat(text), 60);
}

function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

  document.body.addEventListener('click', (e) => {
    if (e.target.closest('#rem-close')) { ui.remindersHidden = true; $('#dash-reminders').classList.add('hidden'); return; }

    const summary = e.target.closest('[data-summary]');
    if (summary) { weeklySummary(); return; }

    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const m = state.chat[Number(copyBtn.dataset.copy)];
      if (m) copyText(m.content);
      return;
    }

    const regenBtn = e.target.closest('[data-regen]');
    if (regenBtn) { regenerate(); return; }

    const rmAttach = e.target.closest('[data-attach-remove]');
    if (rmAttach) {
      ui.attached.splice(Number(rmAttach.dataset.attachRemove), 1);
      renderAttachments();
      return;
    }

    const sr = e.target.closest('[data-sr]');
    if (sr) { openSearchResult((ui.searchShown || [])[Number(sr.dataset.sr)]); return; }

    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) { restoreBackup(restoreBtn.dataset.restore); return; }

    const delBackup = e.target.closest('[data-delbackup]');
    if (delBackup) { deleteBackup(delBackup.dataset.delbackup); return; }

    const delModel = e.target.closest('[data-delmodel]');
    if (delModel) { deleteAiModel(delModel.dataset.delmodel); return; }

    const goto = e.target.closest('[data-goto]');
    if (goto) { go(goto.dataset.goto); return; }

    const example = e.target.closest('[data-example]');
    if (example) { useAiExample(example.dataset.example); return; }

    const newBtn = e.target.closest('[data-new]');
    if (newBtn) {
      const t = newBtn.dataset.new;
      if (t === 'note') openNote();
      if (t === 'event') openEvent();
      if (t === 'task') openTask();
      if (t === 'group') openGroup();
      if (t === 'person') openPerson();
      return;
    }

    const open = e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.id;
      if (open.dataset.open === 'note') openNote(id);
      if (open.dataset.open === 'event') openEvent(id);
      if (open.dataset.open === 'task') openTask(id);
      if (open.dataset.open === 'group') openGroup(id);
      if (open.dataset.open === 'person') openPerson(id);
      return;
    }

    const day = e.target.closest('[data-day]');
    if (day) {
      ui.calSelected = day.dataset.day;
      renderCalendar(); renderEventsDay();
      return;
    }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const t = state.tasks.find((x) => x.id === toggle.dataset.toggle);
      if (t) { t.done = toggle.checked; persist(); renderTasks(); }
      return;
    }
  });

  $('#quick-add').addEventListener('click', () => openNote());
  $('#note-template').addEventListener('change', (e) => {
    const tpl = e.target.value;
    e.target.value = '';
    if (tpl) openNote(null, tpl);
  });
  $('#notes-search').addEventListener('input', renderNotes);
  $('#notes-tag').addEventListener('change', renderNotes);
  $('#events-search').addEventListener('input', renderEventsDay);
  $('#tasks-search').addEventListener('input', renderTasks);
  $('#cal-prev').addEventListener('click', () => { ui.calRef = new Date(ui.calRef.getFullYear(), ui.calRef.getMonth() - 1, 1); renderCalendar(); });
  $('#cal-next').addEventListener('click', () => { ui.calRef = new Date(ui.calRef.getFullYear(), ui.calRef.getMonth() + 1, 1); renderCalendar(); });
  $('#cal-today').addEventListener('click', () => { ui.calRef = new Date(); ui.calSelected = toKey(new Date()); renderCalendar(); renderEventsDay(); });
  $('#events-ics').addEventListener('click', exportIcs);
  $('#events-print').addEventListener('click', printAgenda);

  // Exportar notas y comunidad
  $('#notes-image').addEventListener('click', noteFromImage);
  $('#notes-print').addEventListener('click', printNotes);
  $('#notes-csv').addEventListener('click', exportNotesCsv);
  $('#community-print').addEventListener('click', printCommunity);
  $('#community-csv').addEventListener('click', exportCommunityCsv);

  $$('#task-filter .seg').forEach((b) => b.addEventListener('click', () => {
    ui.taskFilter = b.dataset.f;
    $$('#task-filter .seg').forEach((x) => x.classList.toggle('active', x === b));
    renderTasks();
  }));

  // Modal
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-save').addEventListener('click', saveModal);
  $('#modal-delete').addEventListener('click', async () => {
    if (modalCtx && modalCtx.onDelete) { await modalCtx.onDelete(); closeModal(); toast('Eliminado'); }
  });
  $('#modal-form').addEventListener('submit', (e) => { e.preventDefault(); saveModal(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // Chat
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = $('#chat-text').value;
    $('#chat-text').value = '';
    $('#chat-text').style.height = 'auto';
    sendChat(txt);
  });
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#chat-text').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  });
  $('#chat-attach').addEventListener('click', () => $('#chat-file').click());
  $('#chat-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) await addAttachment(f);
    e.target.value = '';
  });
  $('#chat-text').addEventListener('paste', async (e) => {
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const imgs = items.filter((it) => it.type && it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    for (const it of imgs) {
      const f = it.getAsFile();
      if (f) await addAttachment(f);
    }
  });
  $$('#chat-suggest button').forEach((b) => {
    if (b.dataset.summary) return;
    b.addEventListener('click', () => sendChat(b.dataset.prompt));
  });
  $('#chat-clear').addEventListener('click', async () => { state.chat = []; clearAttachments(); await persist(); renderChat(); });
  $('#chat-stop').addEventListener('click', () => {
    if (!ui.chatBusy) return;
    ui.chatCanceled = true;
    setThinkingStage('stopping');
    if (ui.chatRequestId) api.aiCancel(ui.chatRequestId);
  });
  api.onAiStream(handleAiStream);

  // Settings / IA
  $('#btn-install').addEventListener('click', () => installAi(!!aiMgr.installed));
  $('#btn-pull').addEventListener('click', () => pullModel($('#model-choice'), $('#btn-pull'), $('#ai-progress-text')));
  $('#set-ai-pull').addEventListener('click', () => pullModel($('#set-model-choice'), $('#set-ai-pull'), $('#set-ai-progress')));
  $('#set-ai-install').addEventListener('click', () => installAi(!!aiMgr.installed));
  $('#set-ai-start').addEventListener('click', async () => {
    await api.aiStart(); await refreshAiManager(); await checkAi(); toast('IA iniciada');
  });
  $('#set-ai-stop').addEventListener('click', async () => {
    await api.aiStop(); await refreshAiManager(); await checkAi(); toast('IA detenida');
  });
  $('#set-ai-uninstall').addEventListener('click', async () => {
    if (!confirm('¿Desinstalar la IA? Se borrarán el motor y los modelos descargados.')) return;
    await api.aiUninstall(); await refreshAiManager(); await checkAi(); toast('IA desinstalada');
  });
  $('#chat-mode').addEventListener('change', async (e) => {
    state.settings.chatMode = e.target.value === 'deep' ? 'deep' : 'daily';
    await persist();
    updateChatModeUi();
    updateAiUi();
    toast(state.settings.chatMode === 'deep' ? 'Modelo: Qwen 3.5 9B (profundo)' : 'Modelo: Gemma 4 12B (diario)');
  });
  $('#set-reveal').addEventListener('click', () => api.revealData());
  $('#set-export').addEventListener('click', async () => {
    const out = await api.exportBackup(state);
    if (out) toast('Respaldo guardado en ' + out);
  });
  $('#backup-create').addEventListener('click', async () => {
    const res = await api.backupCreate();
    if (res.ok) { renderBackups(); toast('Copia creada'); } else toast('No se pudo crear la copia');
  });
  $('#backup-reveal').addEventListener('click', () => api.backupReveal());
  $('#set-wipe').addEventListener('click', async () => {
    if (!confirm('¿Borrar TODOS los datos? Esta acción no se puede deshacer.')) return;
    await api.backupCreate();
    state.notes = []; state.events = []; state.tasks = []; state.groups = [];
    state.persons = []; state.chat = [];
    await persist(); render(); toast('Datos eliminados');
  });

  // Búsqueda global
  $('#search-input').addEventListener('input', (e) => { ui.searchSel = 0; renderSearchResults(e.target.value); });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSearchResult((ui.searchShown || [])[ui.searchSel]); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  $('#search').addEventListener('click', (e) => { if (e.target.id === 'search') closeSearch(); });

  // Tema
  $('#set-theme').addEventListener('change', async (e) => {
    state.settings.theme = e.target.value;
    applyTheme();
    await persist();
  });

  // Avisos del sistema
  $('#set-notify').addEventListener('change', async (e) => {
    state.settings.notify = e.target.checked;
    await persist();
    toast(state.settings.notify ? 'Avisos del sistema activados' : 'Avisos del sistema desactivados');
    if (state.settings.notify) checkNotifications();
  });

  // Pantalla de bienvenida
  $('#set-welcome').addEventListener('change', async (e) => {
    state.settings.showWelcome = e.target.checked;
    await persist();
    toast(state.settings.showWelcome ? 'Se mostrará la bienvenida al iniciar' : 'Bienvenida desactivada');
  });

  // Guardar datos personales
  ['set-pastor', 'set-school'].forEach((id) => {
    $('#' + id).addEventListener('change', async () => {
      state.settings.pastorName = $('#set-pastor').value.trim();
      state.settings.schoolName = $('#set-school').value.trim();
      await persist();
      $('#brand-school').textContent = state.settings.schoolName || 'Pastoral Escolar';
      toast('Ajustes guardados');
    });
  });

  document.addEventListener('keydown', (e) => {
    const w = $('#welcome');
    if (w && !w.classList.contains('hidden') && !w.classList.contains('closing')) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); hideWelcome(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openSearch(); return; }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openNote(); return; }
    if (e.key === 'Escape') { closeModal(); closeSearch(); }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (modalCtx) saveModal(); }
  });

  // Pantalla de inicio y de ida
  $('#welcome-enter').addEventListener('click', hideWelcome);
  $('#goodbye-close').addEventListener('click', () => api.confirmQuit());
}

/* ------------------------------------------------------------
   Arranque
   ------------------------------------------------------------ */
async function init() {
  const data = await api.load();
  mergeData(data);
  applyTheme();
  bindEvents();
  if (api.onClosing) api.onClosing(showGoodbye);
  showWelcome();
  api.onAiProgress(handleAiProgress);
  go('dashboard');
  checkAi();
  refreshAiManager();
  setInterval(checkAi, 30000);
  setInterval(refreshAiManager, 60000);
  setInterval(() => { if (ui.view === 'dashboard') renderDashboard(); }, 60000);
  checkNotifications();
  setInterval(checkNotifications, 60000);
}

init();
