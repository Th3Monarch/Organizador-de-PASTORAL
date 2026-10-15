/* ============================================================
   Organizador Pastoral - lógica de la interfaz
   ============================================================ */

const api = window.pastoral;

let state = {
  notes: [], events: [], tasks: [], groups: [], persons: [], chat: [],
  settings: {
    pastorName: '', schoolName: '',
    ollamaUrl: 'http://127.0.0.1:11434', model: 'llama3.2', theme: 'light'
  }
};

let ui = {
  view: 'dashboard',
  calRef: new Date(),
  calSelected: toKey(new Date()),
  taskFilter: 'all',
  chatBusy: false,
  remindersHidden: false,
  searchSel: 0,
  searchItems: []
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
    .filter((e) => e.date >= today)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const pending = state.tasks.filter((t) => !t.done);

  $('#stats').innerHTML = `
    <div class="stat"><div class="n accent">${state.notes.length}</div><div class="l">Ideas y notas</div></div>
    <div class="stat"><div class="n">${upcoming.length}</div><div class="l">Eventos próximos</div></div>
    <div class="stat"><div class="n">${pending.length}</div><div class="l">Tareas pendientes</div></div>
    <div class="stat"><div class="n">${state.persons.length}</div><div class="l">Personas</div></div>`;

  $('#dash-events').innerHTML = upcoming.length ? upcoming.slice(0, 5).map((e) => `
    <div class="list-item" data-open="event" data-id="${e.id}">
      <div class="li-main">
        <div class="li-title">${esc(e.title)}</div>
        <div class="li-sub">${esc(fmtDate(e.date))}${e.time ? ' · ' + esc(e.time) : ''}${e.location ? ' · ' + esc(e.location) : ''}${attendCount(e) ? ' · ' + attendCount(e) : ''}</div>
      </div>
      ${e.category ? `<span class="pill">${esc(e.category)}</span>` : ''}
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
  const evToday = state.events.filter((e) => e.date === today);
  const evTomorrow = state.events.filter((e) => e.date === tomorrow);
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

function openNote(id, templateId) {
  const n = state.notes.find((x) => x.id === id);
  const tpl = (!n && templateId) ? NOTE_TEMPLATES[templateId] : null;
  openModal({
    title: n ? 'Editar nota' : 'Nueva nota',
    fields: [
      { key: 'title', label: 'Título', type: 'text', placeholder: 'Título de la idea' },
      { key: 'body', label: 'Contenido', type: 'textarea', placeholder: 'Escribe aquí...' },
      { key: 'tags', label: 'Etiquetas (separadas por coma)', type: 'text', placeholder: 'oración, retiro, campaña' }
    ],
    values: n ? { ...n, tags: (n.tags || []).join(', ') }
      : tpl ? { title: tpl.title, body: tpl.body, tags: tpl.tags }
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
    const evs = state.events.filter((e) => e.date === key).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const classes = ['cal-day'];
    if (d.getMonth() !== month) classes.push('other');
    if (key === todayKey) classes.push('today');
    if (key === ui.calSelected) classes.push('selected');
    const evHtml = evs.slice(0, 3).map((e) => `<div class="ev">${e.time ? esc(e.time) + ' ' : ''}${esc(e.title)}</div>`).join('');
    const more = evs.length > 3 ? `<div class="ev more">+${evs.length - 3} más</div>` : '';
    html += `<div class="${classes.join(' ')}" data-day="${key}"><div class="d">${d.getDate()}</div>${evHtml}${more}</div>`;
  }
  $('#calendar').innerHTML = html;
}

function renderEventsDay() {
  const key = ui.calSelected;
  $('#events-day-title').textContent = 'Eventos · ' + fmtDate(key);
  const q = ($('#events-search').value || '').toLowerCase();
  let list = state.events.filter((e) => e.date === key).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (q) list = list.filter((e) => (e.title + ' ' + (e.description || '')).toLowerCase().includes(q));
  $('#events-day').innerHTML = list.length ? list.map((e) => `
    <div class="list-item" data-open="event" data-id="${e.id}">
      <span class="pill date">${e.time ? esc(e.time) : 'Todo el día'}</span>
      <div class="li-main">
        <div class="li-title">${esc(e.title)}</div>
        <div class="li-sub">${esc(e.location || e.description || '')}${attendCount(e) ? (e.location || e.description ? ' · ' : '') + attendCount(e) : ''}</div>
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
      { key: 'description', label: 'Descripción', type: 'textarea', placeholder: 'Detalles del evento...' },
      { key: 'attendance', label: 'Asistencia', type: 'people' }
    ],
    values: e ? { ...e, attendance: e.attendance || [] } : { date: defaultDate || ui.calSelected, attendance: [] },
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

async function refreshAiManager() {
  try { aiMgr = await api.aiManagerStatus(); } catch (e) { /* noop */ }
  updateChatModelSelect();
  updateAiUi();
}

function updateChatModelSelect() {
  const models = aiMgr.models || [];
  const sel = $('#chat-model');
  if (!models.length) { sel.innerHTML = `<option value="">Sin modelo</option>`; return; }
  if (!models.includes(state.settings.model)) state.settings.model = models[0];
  sel.innerHTML = models.map((m) => `<option value="${esc(m)}"${m === state.settings.model ? ' selected' : ''}>${esc(m)}</option>`).join('');
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

  chat.classList.toggle('hidden', !ready);
  setup.classList.toggle('hidden', ready);

  if (ready) { chip.className = 'pill ok'; chip.textContent = '● IA lista'; }
  else if (running) { chip.className = 'pill warn'; chip.textContent = '● Falta el modelo'; }
  else if (installed) { chip.className = 'pill warn'; chip.textContent = '● IA detenida'; }
  else { chip.className = 'pill red'; chip.textContent = '● IA no instalada'; }

  engineStep.classList.toggle('done', installed);
  $('#step-engine-desc').textContent = installed ? 'Instalado' : 'Pendiente';
  $('#btn-install').textContent = installed ? 'Reparar' : 'Instalar';

  modelStep.classList.toggle('done', hasModel);
  $('#btn-pull').disabled = !(installed && running);
}

function setBar(id, percent) {
  const bar = $('#' + id);
  bar.classList.remove('hidden');
  bar.querySelector('.bar-fill').style.width = Math.max(0, Math.min(100, percent)) + '%';
}

function handleAiProgress(d) {
  $('#ai-progress-text').textContent = d.status || '';
  if (d.phase === 'download' || d.phase === 'extract') {
    setBar('bar-engine', d.percent || 0);
    const badge = $('#ai-badge');
    badge.className = 'ai-badge busy';
    badge.textContent = '● Instalando IA...';
  } else if (d.phase === 'pull') {
    setBar('bar-model', d.percent || 0);
    const badge = $('#ai-badge');
    badge.className = 'ai-badge busy';
    badge.textContent = '● Bajando modelo...';
  } else if (d.phase === 'done') {
    $('#bar-engine').classList.add('hidden');
    $('#bar-model').classList.add('hidden');
    refreshAiManager(); checkAi();
  } else if (d.phase === 'error') {
    $('#bar-engine').classList.add('hidden');
    $('#bar-model').classList.add('hidden');
    toast(d.status || 'Error al preparar la IA');
    refreshAiManager();
  }
}

async function installAi(force) {
  $('#btn-install').disabled = true;
  $('#btn-pull').disabled = true;
  $('#ai-progress-text').textContent = 'Iniciando instalación...';
  const res = await api.aiInstall(force);
  $('#btn-install').disabled = false;
  await refreshAiManager();
  await checkAi();
  if (res.ok) toast('Motor de IA instalado');
  else toast('Error: ' + res.error);
}

async function pullModel() {
  const model = $('#model-choice').value;
  if (!model) return;
  $('#btn-pull').disabled = true;
  state.settings.model = model;
  $('#ai-progress-text').textContent = 'Iniciando descarga del modelo...';
  const res = await api.aiPull(model);
  if (!res.ok) { toast('Error: ' + res.error); $('#btn-pull').disabled = false; return; }
  await persist();
  await refreshAiManager();
  await checkAi();
  toast('Modelo listo');
}

function renderChat() {
  $('#chat-log').innerHTML = state.chat.length
    ? state.chat.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${esc(m.content)}</div>`).join('')
    : `<div class="empty">Conversa con tu asistente local. Prueba una sugerencia debajo.</div>`;
  $('#chat-suggest').classList.toggle('hidden', state.chat.length > 0);
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
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
      category: (a.category || '').trim(), description: (a.description || '').trim(), attendance: []
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
    messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result) });
  }
  if (done.length) await persist();
  return { messages, done };
}

function buildContextSummary() {
  const today = toKey(new Date());
  const parts = [];
  parts.push(`Hoy es ${today}.`);
  parts.push(`Total: ${state.notes.length} notas, ${state.events.length} eventos, ${state.tasks.filter((t) => !t.done).length} tareas pendientes, ${state.groups.length} grupos, ${state.persons.length} personas.`);
  const upcoming = state.events.filter((e) => e.date >= today)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 8);
  if (upcoming.length) parts.push('Próximos eventos: ' + upcoming.map((e) => `${e.title} (${e.date}${e.time ? ' ' + e.time : ''})`).join('; ') + '.');
  const pending = state.tasks.filter((t) => !t.done)
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 8);
  if (pending.length) parts.push('Tareas pendientes: ' + pending.map((t) => `${t.title}${t.due ? ' (' + t.due + ')' : ''}`).join('; ') + '.');
  if (state.groups.length) parts.push('Grupos: ' + state.groups.map((g) => g.name).slice(0, 12).join(', ') + '.');
  const notes = [...state.notes].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  if (notes.length) parts.push('Últimas notas: ' + notes.map((n) => n.title || 'Sin título').join('; ') + '.');
  if (state.persons.length) parts.push('Personas: ' + state.persons.map((p) => p.name + (p.role ? ` (${p.role})` : '')).slice(0, 15).join(', ') + '.');
  return parts.join('\n');
}

async function sendChat(text) {
  if (ui.chatBusy || !text.trim()) return;
  ui.chatBusy = true;
  state.chat.push({ role: 'user', content: text.trim() });
  renderChat();
  const log = $('#chat-log');
  const thinking = document.createElement('div');
  thinking.className = 'msg assistant thinking';
  thinking.textContent = 'Pensando...';
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;

  await persist();

  const system = {
    role: 'system',
    content: `Eres el asistente de la pastoral de un colegio${state.settings.schoolName ? ' (' + state.settings.schoolName + ')' : ''}${state.settings.pastorName ? ', responsable ' + state.settings.pastorName : ''}. ` +
      `Ayudas a organizar ideas, eventos, retiros, campañas, tareas, grupos y personas. Responde en español, de forma práctica, cálida y concisa. ` +
      `Usa lenguaje respetuoso y valores cristianos.\n` +
      `Puedes CREAR elementos (notas, eventos, tareas, grupos y personas) con las herramientas disponibles. ` +
      `Cuando el usuario pida añadir, crear o registrar algo, llama a la herramienta correspondiente. Si falta un dato imprescindible (por ejemplo la fecha de un evento), pídelo antes de crearlo. ` +
      `No inventes datos. Cuando ya tengas la información suficiente, actúa directamente.\n` +
      `Contexto actual de la app:\n${buildContextSummary()}`
  };

  const messages = [system, ...state.chat.slice(-12)];
  const actions = [];
  let finalContent = '';

  try {
    for (let step = 0; step < 6; step++) {
      const res = await api.aiChat({ url: state.settings.ollamaUrl, model: state.settings.model, messages, tools: AI_TOOLS });
      if (!res.ok) {
        finalContent = `⚠ No se pudo conectar con la IA local.\n\n${res.error}\n\nRevisa que el motor esté en marcha (Ajustes / IA).`;
        break;
      }
      const calls = res.tool_calls || [];
      if (!calls.length) { finalContent = (res.content || '').trim(); break; }
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: calls });
      const handled = await runToolCalls(calls);
      messages.push(...handled.messages);
      handled.done.forEach((d) => actions.push(d));
      if (handled.done.length) toast('Creado: ' + handled.done.map((d) => `${d.kind} «${d.label}»`).join(', '));
      if (step === 5) finalContent = 'He terminado las acciones solicitadas.';
    }
    if (finalContent) state.chat.push({ role: 'assistant', content: finalContent });
    else if (actions.length) state.chat.push({ role: 'assistant', content: 'Hecho. ' + actions.map((d) => `Creé la ${d.kind} «${d.label}»`).join(', ') + '.' });
    await persist();
  } catch (err) {
    state.chat.push({ role: 'assistant', content: `Error: ${String(err.message || err)}` });
    await persist();
    toast('Error al enviar mensaje');
  } finally {
    try { thinking.remove(); } catch (e) { /* noop */ }
    ui.chatBusy = false;
    renderChat();
    render();
  }
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
  try { $('#set-datapath').textContent = await api.dataPath(); } catch (e) { /* noop */ }
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
    if (!st.models.includes(state.settings.model) && st.models.length) {
      state.settings.model = st.models[0];
      await persist();
    }
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
        f.options.map((o) => `<option value="${esc(o)}"${String(val) === String(o) ? ' selected' : ''}>${esc(o || '—')}</option>`).join('') +
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
  html += evs.length ? evs.map((e) => `<div class="pr-item"><span class="pr-date">${esc(fmtDate(e.date))}${e.time ? ' · ' + esc(e.time) : ''}</span> — ${esc(e.title)}${e.location ? ' · ' + esc(e.location) : ''}${e.category ? ' · ' + esc(e.category) : ''}</div>`).join('') : '<p>No hay eventos.</p>';
  const pending = state.tasks.filter((t) => !t.done);
  html += '<h2>Tareas pendientes</h2>';
  html += pending.length ? pending.map((t) => `<div class="pr-item">${esc(t.title)}${t.due ? ' · ' + esc(fmtDate(t.due)) : ''} ${t.priority ? '(' + esc(prioLabel(t.priority)) + ')' : ''}</div>`).join('') : '<p>Sin tareas pendientes.</p>';
  area.innerHTML = html;
  window.print();
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

    const sr = e.target.closest('[data-sr]');
    if (sr) { openSearchResult((ui.searchShown || [])[Number(sr.dataset.sr)]); return; }

    const restoreBtn = e.target.closest('[data-restore]');
    if (restoreBtn) { restoreBackup(restoreBtn.dataset.restore); return; }

    const delBackup = e.target.closest('[data-delbackup]');
    if (delBackup) { deleteBackup(delBackup.dataset.delbackup); return; }

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
  $$('#chat-suggest button').forEach((b) => {
    if (b.dataset.summary) return;
    b.addEventListener('click', () => sendChat(b.dataset.prompt));
  });
  $('#chat-clear').addEventListener('click', async () => { state.chat = []; await persist(); renderChat(); });

  // Settings / IA
  $('#btn-install').addEventListener('click', () => installAi(!!aiMgr.installed));
  $('#btn-pull').addEventListener('click', pullModel);
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
  $('#chat-model').addEventListener('change', async (e) => {
    state.settings.model = e.target.value; await persist();
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
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openSearch(); return; }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); openNote(); return; }
    if (e.key === 'Escape') { closeModal(); closeSearch(); }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); if (modalCtx) saveModal(); }
  });
}

/* ------------------------------------------------------------
   Arranque
   ------------------------------------------------------------ */
async function init() {
  const data = await api.load();
  mergeData(data);
  applyTheme();
  bindEvents();
  api.onAiProgress(handleAiProgress);
  go('dashboard');
  checkAi();
  refreshAiManager();
  setInterval(checkAi, 30000);
  setInterval(refreshAiManager, 60000);
  setInterval(() => { if (ui.view === 'dashboard') renderDashboard(); }, 60000);
}

init();
