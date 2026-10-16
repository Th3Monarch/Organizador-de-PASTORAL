/* ============================================================
   Proveedor de IA en la nube (opcional).
   Compatible con servicios tipo OpenAI (/chat/completions) y
   tipo Anthropic (/messages). Solo se usa si el usuario activa
   el modo nube en Ajustes; la app sigue funcionando sin conexión
   con la IA local (Ollama).
   ============================================================ */

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(url || ''));
  if (!m) return null;
  return { mediaType: m[1], base64: !!m[2], data: m[3] };
}

function asText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || '').join('');
  return content == null ? '' : String(content);
}

function asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (content) return [{ type: 'text', text: String(content) }];
  return [];
}

/* ---------- OpenAI ---------- */
function openAiMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || m.tool_name || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content)
      });
      continue;
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls;
      out.push(msg);
      continue;
    }
    if (Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img } });
      out.push({ role: m.role || 'user', content: parts });
    } else {
      out.push({ role: m.role || 'user', content: m.content || '' });
    }
  }
  return out;
}

async function openAiChat(cfg, messages, tools, signal, onDelta) {
  const base = normalizeBase(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
  const body = { model: cfg.model, messages: openAiMessages(messages), stream: true };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(data); } catch (e) { continue; }
      if (obj.error) return { ok: false, error: (obj.error && obj.error.message) || String(obj.error) };
      const choice = (obj.choices || [])[0] || {};
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) { content += delta.content; onDelta(delta.content); }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          const fn = tc.function || {};
          if (fn.name) toolCalls[idx].function.name = fn.name;
          if (fn.arguments) toolCalls[idx].function.arguments += fn.arguments;
        }
      }
    }
  }
  return { ok: true, content, tool_calls: toolCalls.filter(Boolean) };
}

/* ---------- Anthropic ---------- */
function anthropicTools(tools) {
  return (tools || []).filter((t) => t && t.function).map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }));
}

function anthropicMessages(messages) {
  const systemParts = [];
  const raw = [];
  let toolGroup = null;
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system') { if (m.content) systemParts.push(asText(m.content)); continue; }
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content)
      };
      if (toolGroup) toolGroup.content.push(block);
      else { toolGroup = { role: 'user', content: [block] }; raw.push(toolGroup); }
      continue;
    }
    toolGroup = null;
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.tool_calls || []) {
        const fn = (call && call.function) || {};
        let input = {};
        try { input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}); } catch (e) { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id || '', name: fn.name || '', input });
      }
      raw.push({ role: 'assistant', content: blocks.length ? blocks : (m.content || '') });
      continue;
    }
    const blocks = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    if (Array.isArray(m.images)) {
      for (const img of m.images) {
        const p = parseDataUrl(img);
        if (p && p.base64) blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
      }
    }
    raw.push({ role: 'user', content: blocks.length ? blocks : (m.content || '') });
  }

  // Anthropic exige mensajes alternos empezando por "user".
  const merged = [];
  for (const msg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = asBlocks(last.content).concat(asBlocks(msg.content));
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }
  while (merged.length && merged[0].role === 'assistant') merged.shift();
  return { system: systemParts.join('\n\n'), messages: merged };
}

async function anthropicChat(cfg, messages, tools, signal, onDelta) {
  const base = normalizeBase(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (cfg.apiKey) { headers['x-api-key'] = cfg.apiKey; headers.Authorization = 'Bearer ' + cfg.apiKey; }
  const built = anthropicMessages(messages);
  const body = { model: cfg.model, max_tokens: 4096, stream: true, messages: built.messages };
  if (built.system) body.system = built.system;
  const atools = anthropicTools(tools);
  if (atools.length) body.tools = atools;
  const res = await fetch(`${base}/messages`, {
    method: 'POST', headers, body: JSON.stringify(body), signal
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  let current = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s || !s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(data); } catch (e) { continue; }
      if (obj.type === 'error' || obj.error) {
        return { ok: false, error: (obj.error && obj.error.message) || String(obj.error || 'Error del servicio') };
      }
      if (obj.type === 'content_block_start') {
        const cb = obj.content_block || {};
        if (cb.type === 'tool_use') {
          current = { id: cb.id || '', type: 'function', function: { name: cb.name || '', arguments: '' } };
          toolCalls.push(current);
        } else if (cb.type === 'text' && cb.text) {
          content += cb.text; onDelta(cb.text);
        }
      } else if (obj.type === 'content_block_delta') {
        const d = obj.delta || {};
        if (d.type === 'text_delta' && d.text) { content += d.text; onDelta(d.text); }
        else if (d.type === 'input_json_delta' && current) { current.function.arguments += d.partial_json || ''; }
      } else if (obj.type === 'content_block_stop') {
        current = null;
      }
    }
  }
  return { ok: true, content, tool_calls: toolCalls };
}

async function chat(cfg, options) {
  const opts = options || {};
  const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : () => {};
  const signal = opts.signal;
  if (!normalizeBase(cfg && cfg.baseUrl)) return { ok: false, error: 'Falta la dirección del servicio (URL).' };
  if (!cfg || !cfg.model) return { ok: false, error: 'Falta el nombre del modelo.' };
  const messages = cfg.messages || [];
  const tools = cfg.tools || [];
  if (cfg.format === 'anthropic') return anthropicChat(cfg, messages, tools, signal, onDelta);
  return openAiChat(cfg, messages, tools, signal, onDelta);
}

module.exports = {
  chat,
  normalizeBase,
  parseDataUrl,
  openAiMessages,
  anthropicMessages,
  anthropicTools
};
