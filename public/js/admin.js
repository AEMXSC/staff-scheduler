import '/vendor/spectrum.js';
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { convertGrid } from './grid-convert.js';
import { getFreeFloaters, overlappingShifts } from './schedule.js';
import { toMins, escapeHtml } from './time-utils.js';
import { resolveEventId, applyTheme, eventLogo } from './event-config.js';

const eventId = resolveEventId();
const SESSION_KEY = 'staff-scheduler-admin-token';

const root = document.getElementById('admin-app');
root.innerHTML = `
  <header class="app-header">
    <div class="brand-row">
      <img class="brand-adobe-logo" src="/images/adobe-logo.svg" alt="Adobe">
      <span class="brand-divider" aria-hidden="true"></span>
      <img class="brand-ibc-logo" alt="">
    </div>
    <h1>Schedule Admin</h1>
    <p class="app-sub">Ask questions or request changes — nothing is applied until you confirm it.</p>
  </header>
  <div class="admin-auth" id="admin-auth">
    <sp-field-label for="admin-pass">Passphrase</sp-field-label>
    <div class="admin-auth-row">
      <sp-textfield type="password" id="admin-pass" label="Passphrase" autocomplete="off"></sp-textfield>
      <sp-button id="admin-unlock" variant="primary">Unlock</sp-button>
    </div>
    <p class="hint" id="admin-auth-hint"></p>
  </div>
  <div class="admin-tools" id="admin-tools" hidden>
    <div class="admin-tool">
      <span class="admin-tool-label">Master schedule (.xlsx) — rebuilds the schedule</span>
      <sp-button class="admin-file-btn" data-for="upload-schedule" size="s" variant="secondary" treatment="outline">Choose file</sp-button>
      <input type="file" id="upload-schedule" accept=".xlsx,.xls" hidden>
    </div>
    <div class="admin-tool">
      <span class="admin-tool-label">Contacts (.xlsx) — rebuilds the directory</span>
      <sp-button class="admin-file-btn" data-for="upload-contacts" size="s" variant="secondary" treatment="outline">Choose file</sp-button>
      <input type="file" id="upload-contacts" accept=".xlsx,.xls" hidden>
    </div>
    <p class="admin-tool-status" id="admin-tool-status"></p>
  </div>
  <div class="admin-requests" id="admin-requests" hidden>
    <div class="admin-requests-head">
      <h2 class="admin-section-title">Shift change requests <sp-badge size="s" variant="negative" id="admin-requests-badge" hidden>0</sp-badge></h2>
      <div class="admin-requests-actions">
        <sp-button id="admin-push-btn" size="s" variant="secondary" treatment="outline">Enable phone alerts</sp-button>
        <sp-button id="admin-requests-refresh" size="s" variant="secondary" treatment="outline">Refresh</sp-button>
      </div>
    </div>
    <div class="admin-requests-list" id="admin-requests-list"></div>
  </div>
  <div class="admin-recent" id="admin-recent" hidden>
    <h2 class="admin-section-title">Recently applied</h2>
    <div class="admin-recent-list" id="admin-recent-list"></div>
  </div>
  <div class="admin-chat" id="admin-chat" hidden>
    <div class="admin-messages" id="admin-messages"></div>
    <div class="admin-input-bar">
      <sp-textfield id="admin-textarea" class="admin-textarea" multiline grows label="Message" placeholder="Ask about or change the schedule"></sp-textfield>
      <sp-button id="admin-send" variant="primary" disabled>Send</sp-button>
    </div>
  </div>`;

// Theme the admin page (incl. the auth screen) from the event config on load.
let eventShortName = 'the event';
(async () => {
  try {
    const ev = await (await fetch(`/events/${eventId}.json`)).json();
    applyTheme(ev);
    eventShortName = (ev.branding && ev.branding.shortName) || ev.name || eventShortName;
    const logo = eventLogo(ev);
    const img = root.querySelector('.brand-ibc-logo');
    if (img) { img.src = logo.src; img.alt = logo.alt; }
    if (ev.branding && ev.branding.logoIncludesAdobe) root.querySelectorAll('.brand-adobe-logo, .brand-divider').forEach((n) => n.remove());
    if (ev.shiftChangeRequests === false) root.classList.add('no-requests');
  } catch { /* keep default branding */ }
})();

const authEl = document.getElementById('admin-auth');
const passInput = document.getElementById('admin-pass');
const unlockBtn = document.getElementById('admin-unlock');
const authHint = document.getElementById('admin-auth-hint');
const chatEl = document.getElementById('admin-chat');
const messagesEl = document.getElementById('admin-messages');
const textarea = document.getElementById('admin-textarea');
const sendBtn = document.getElementById('admin-send');
const toolsEl = document.getElementById('admin-tools');
const requestsPanel = document.getElementById('admin-requests');
const requestsList = document.getElementById('admin-requests-list');
const requestsRefresh = document.getElementById('admin-requests-refresh');
const requestsBadge = document.getElementById('admin-requests-badge');
const pushBtn = document.getElementById('admin-push-btn');
const recentPanel = document.getElementById('admin-recent');
const recentList = document.getElementById('admin-recent-list');
const scheduleInput = document.getElementById('upload-schedule');
const contactsInput = document.getElementById('upload-contacts');
const toolStatus = document.getElementById('admin-tool-status');

let token = '';
try { token = sessionStorage.getItem(SESSION_KEY) || ''; } catch { /* noop */ }

// Sent back on every request so follow-ups ("and floaters?") have context --
// capped so a long session doesn't grow the request unboundedly.
const MAX_HISTORY = 20;
let history = [];

let pollTimer = null;
// Uploaders are a setup tool, hidden from the day-to-day admin view; reveal
// with ?tools=1 when loading a new schedule/contacts sheet.
const SHOW_TOOLS = new URLSearchParams(window.location.search).get('tools') === '1';

const CHAT_INTRO = 'How can I help you today? You can ask me about the schedule '
  + '— e.g. "who\'s on Photoshop Friday?" or "how many people Saturday?" — or make a change like '
  + '"swap Chris and Angela on Friday", "move Sam to Stock", or "cancel Dave\'s Saturday shift." '
  + 'I\'ll show you the before/after and you confirm before anything updates.';

function showChat() {
  authEl.hidden = true;
  toolsEl.hidden = !SHOW_TOOLS;
  requestsPanel.hidden = false;
  chatEl.hidden = false;
  if (!messagesEl.children.length) addMessage('ai', CHAT_INTRO);
  loadRequestContext().then(() => { loadRequests(true); loadRecent(); });
  // Live inbox: poll while the admin page is open so new requests + applied
  // changes surface without a manual refresh (Geneliz is "on the app").
  if (!pollTimer) pollTimer = setInterval(() => { loadRequests(false); loadRecent(); }, 20000);
  textarea.focus();
}

if (token) showChat();

async function unlock() {
  const passphrase = passInput.value.trim();
  if (!passphrase) return;
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Unlocking…';
  authHint.textContent = '';
  try {
    const resp = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    const data = await resp.json();
    if (resp.ok && data.token) {
      token = data.token;
      try { sessionStorage.setItem(SESSION_KEY, token); } catch { /* noop */ }
      showChat();
    } else {
      authHint.textContent = resp.status === 429 ? 'Too many attempts — try again later.' : 'Wrong passphrase.';
    }
  } catch {
    authHint.textContent = 'Network error.';
  } finally {
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock';
  }
}

unlockBtn.addEventListener('click', unlock);
passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });

function spButton(text, variant) {
  const b = document.createElement('sp-button');
  b.setAttribute('size', 's');
  b.setAttribute('variant', variant);
  if (variant === 'secondary') b.setAttribute('treatment', 'outline');
  b.textContent = text;
  return b;
}

function addMessage(role, text) {
  const row = document.createElement('div');
  row.className = `admin-msg admin-msg-${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'admin-bubble';
  bubble.textContent = text;
  row.append(bubble);
  messagesEl.append(row);
  return row;
}

function renderTable(table) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-table-wrap';
  const el = document.createElement('table');
  el.className = 'admin-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  table.headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.append(th);
  });
  thead.append(headRow);
  el.append(thead);
  const tbody = document.createElement('tbody');
  table.rows.forEach((cells) => {
    const tr = document.createElement('tr');
    cells.forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.append(td);
    });
    tbody.append(tr);
  });
  el.append(tbody);
  wrap.append(el);
  return wrap;
}

function renderPendingAction(bubble, pendingAction) {
  const actions = document.createElement('div');
  actions.className = 'admin-pending-actions';
  const confirmBtn = spButton('Confirm', 'primary');
  const cancelBtn = spButton('Cancel', 'secondary');

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Applying…';
    try {
      const resp = await fetch('/api/admin/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ eventId, pendingAction }),
      });
      const data = await resp.json();
      actions.remove();
      if (resp.ok) {
        addMessage('ai', `✓ ${data.message}`);
      } else {
        addMessage('ai', `⚠ ${data.error || 'Could not apply the change.'}`);
      }
    } catch {
      actions.remove();
      addMessage('ai', '⚠ Network error while applying the change.');
    }
  });

  cancelBtn.addEventListener('click', () => {
    actions.remove();
    addMessage('ai', 'Cancelled — nothing was changed.');
  });

  actions.append(confirmBtn, cancelBtn);
  bubble.append(actions);
}

async function send() {
  const message = textarea.value.trim();
  if (!message) return;
  addMessage('user', message);
  textarea.value = '';
  sendBtn.disabled = true;

  history.push({ role: 'user', content: message });
  history = history.slice(-MAX_HISTORY);

  const thinking = addMessage('ai', '…');

  try {
    const resp = await fetch('/api/admin/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: history, eventId }),
    });

    if (resp.status === 401) {
      thinking.remove();
      token = '';
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
      chatEl.hidden = true;
      authEl.hidden = false;
      authHint.textContent = 'Session expired — unlock again.';
      return;
    }

    const data = await resp.json();
    thinking.remove();
    const row = addMessage('ai', data.message || 'Done.');
    const bubble = row.querySelector('.admin-bubble');
    if (data.table) bubble.append(renderTable(data.table));
    if (data.pendingAction) renderPendingAction(bubble, data.pendingAction);

    history.push({ role: 'assistant', content: data.message || 'Done.' });
    history = history.slice(-MAX_HISTORY);
  } catch {
    thinking.remove();
    addMessage('ai', '⚠ Network error.');
  }
}

textarea.addEventListener('input', () => {
  sendBtn.disabled = !textarea.value.trim();
});
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);

// --- admin uploads: xlsx parsed in-browser, posted as flat rows ---

function setStatus(msg, kind) {
  toolStatus.textContent = msg;
  toolStatus.dataset.kind = kind || '';
}

async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: 'array' });
}

// Case-insensitive column pick from a header-keyed row object.
function pick(row, candidates) {
  const lower = {};
  Object.keys(row).forEach((k) => { lower[k.toLowerCase().trim()] = row[k]; });
  for (const c of candidates) {
    const v = lower[c];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

async function uploadSchedule(file) {
  // Destructive: replaces the whole event schedule. Confirm before parsing.
  if (!window.confirm(`This replaces the ENTIRE schedule for "${eventId}". Continue?`)) return;
  setStatus(`Reading ${file.name}…`);
  try {
    const wb = await readWorkbook(file);
    const sheetsMap = {};
    wb.SheetNames.forEach((n) => {
      sheetsMap[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false, blankrows: true });
    });
    const { rows, warnings } = convertGrid(sheetsMap);
    if (!rows.length) { setStatus('No shift rows found — check the sheet layout (day tabs, header row).', 'err'); return; }
    setStatus(`Uploading ${rows.length} shifts…`);
    const resp = await fetch('/api/admin/schedule-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId, rows }),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus(`⚠ ${data.error || 'Upload failed.'}`, 'err'); return; }
    const warnNote = warnings.length ? ` — ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '';
    setStatus(`✓ ${data.message}${warnNote}`, 'ok');
    addMessage('ai', `✓ ${data.message}${warnings.length ? `\n- ${warnings.join('\n- ')}` : ''}`);
  } catch (e) {
    setStatus(`⚠ Could not read that file: ${e.message}`, 'err');
  }
}

async function uploadContacts(file) {
  setStatus(`Reading ${file.name}…`);
  try {
    const wb = await readWorkbook(file);
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    const rows = raw.map((r) => {
      // Accept either a single "Name" column or split First/Last columns.
      const first = pick(r, ['first name', 'first', 'given name']);
      const last = pick(r, ['last name', 'last', 'surname', 'family name']);
      const name = pick(r, ['name', 'full name', 'staff', 'staff name'])
        || [first, last].filter(Boolean).join(' ') || null;
      return {
        name,
        email: pick(r, ['email', 'e-mail', 'email address']),
        phone: pick(r, ['phone', 'phone number', 'mobile', 'cell', 'cell phone']),
        slack: pick(r, ['slack', 'slack handle', 'slack id']),
        whatsapp: pick(r, ['whatsapp', 'whats app', 'wa']),
        title: pick(r, ['title', 'title for badge', 'badge title', 'role']),
        manager: pick(r, ['manager', 'manager name', 'reports to']),
      };
    }).filter((r) => r.name);
    if (!rows.length) { setStatus('No named contacts found — need a "Name" column, or First/Last name columns.', 'err'); return; }
    setStatus(`Uploading ${rows.length} contacts…`);
    const resp = await fetch('/api/admin/contacts-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId, rows }),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus(`⚠ ${data.error || 'Upload failed.'}`, 'err'); return; }
    setStatus(`✓ ${data.message}`, 'ok');
    addMessage('ai', `✓ ${data.message}`);
  } catch (e) {
    setStatus(`⚠ Could not read that file: ${e.message}`, 'err');
  }
}

root.querySelectorAll('.admin-file-btn').forEach((b) => {
  b.addEventListener('click', () => document.getElementById(b.dataset.for).click());
});
scheduleInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) uploadSchedule(file);
  e.target.value = '';
});
contactsInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) uploadContacts(file);
  e.target.value = '';
});

// --- shift-change request inbox: approve applies via the server; decline closes ---

let scheduleData = [];
let contactsByName = {};
let slackChannelId = '';

async function loadRequestContext() {
  try {
    const [sched, contacts, ev] = await Promise.all([
      fetch(`/api/schedule/${eventId}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/admin/contacts?eventId=${eventId}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : [])),
      fetch(`/events/${eventId}.json`).then((r) => (r.ok ? r.json() : {})),
    ]);
    scheduleData = Array.isArray(sched) ? sched : [];
    contactsByName = {};
    (contacts || []).forEach((c) => { if (c.name) contactsByName[c.name.trim().toLowerCase()] = c; });
    slackChannelId = ev.slackChannelId || '';
  } catch { /* context is best-effort */ }
}

function smsLink(name, body) {
  const c = contactsByName[(name || '').trim().toLowerCase()];
  if (!c || !c.phone) return null;
  return `sms:${c.phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(body)}`;
}

async function resolveRequest(req, action, coverer, resultEl) {
  resultEl.textContent = action === 'approve' ? 'Applying…' : 'Declining…';
  try {
    const resp = await fetch('/api/admin/requests/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: req.id, action, covererName: coverer }),
    });
    const data = await resp.json();
    if (!resp.ok) { resultEl.dataset.kind = 'err'; resultEl.textContent = data.error || 'Failed.'; return; }
    resultEl.dataset.kind = 'ok';
    resultEl.textContent = data.message || 'Done.';
    if (action === 'approve') {
      const who = data.coverer || coverer;
      const win = `${req.station} ${req.requested_start || req.start_time}-${req.requested_end || req.end_time}`;
      const links = [
        [req.requester_name, `Your ${win} shift on ${req.day} is covered by ${who}.`],
        [who, `You're confirmed to cover ${win} on ${req.day} at ${eventShortName}.`],
      ];
      links.forEach(([person, body]) => {
        const href = smsLink(person, body);
        if (!href) return;
        const a = spButton(`Text ${person}`, 'secondary');
        a.classList.add('admin-sms-link');
        a.href = href;
        resultEl.append(document.createTextNode(' '), a);
      });
      if (slackChannelId) {
        const a = spButton('Open Slack', 'secondary');
        a.classList.add('admin-sms-link');
        a.href = `slack://app_redirect?channel=${encodeURIComponent(slackChannelId)}`;
        resultEl.append(document.createTextNode(' '), a);
      }
    }
    setTimeout(() => { loadRequests(); loadRecent(); }, 2500);
  } catch {
    resultEl.dataset.kind = 'err';
    resultEl.textContent = 'Network error.';
  }
}

function renderRequest(req) {
  const card = document.createElement('div');
  card.className = 'admin-request-card';

  // The window actually being handed off; falls back to the full shift for
  // legacy requests filed before requested_start/end existed.
  const covStart = req.requested_start || req.start_time;
  const covEnd = req.requested_end || req.end_time;
  const isPartial = covStart !== req.start_time || covEnd !== req.end_time;

  const head = document.createElement('div');
  head.className = 'admin-request-head';
  head.textContent = `${req.requester_name} · ${req.station} · ${req.day} ${covStart}-${covEnd}`;
  card.append(head);

  const ask = document.createElement('div');
  ask.className = 'admin-request-sub';
  const askWho = req.target_name ? `Asked: ${req.target_name}` : 'Open ask — anyone can cover';
  ask.textContent = isPartial
    ? `${askWho} · covers only ${covStart}-${covEnd} of ${req.start_time}-${req.end_time}`
    : askWho;
  card.append(ask);

  const note = document.createElement('div');
  note.className = 'admin-request-note';
  note.textContent = req.target_name
    ? `✓ ${req.target_name} accepted — approve to confirm.`
    : 'Open ask — pick who covers (names are self-reported).';
  card.append(note);

  if (req.message) {
    const m = document.createElement('div');
    m.className = 'admin-request-msg';
    m.textContent = req.message;
    card.append(m);
  }

  // Soft heads-up when the proposed coverer already has a shift overlapping the
  // covered window (a floater doubling up). Updates as the coverer is picked.
  const warn = document.createElement('div');
  warn.className = 'admin-request-warn';
  warn.hidden = true;
  const renderWarn = (name) => {
    const clashes = overlappingShifts(scheduleData, name, req.day, covStart, covEnd, req.shift_id);
    if (!clashes.length) { warn.hidden = true; warn.textContent = ''; return; }
    const what = clashes.map((c) => `${c.station} ${c.start_time}-${c.end_time}${c.is_floater ? ' (floater)' : ''}`).join(', ');
    warn.textContent = `⚠ ${name} is already on ${what} — overlaps this window.`;
    warn.hidden = false;
  };

  const controls = document.createElement('div');
  controls.className = 'admin-request-controls';

  // Open ask needs a coverer pick; directed uses the named target.
  let covererSelect = null;
  if (!req.target_name) {
    covererSelect = document.createElement('sp-picker');
    covererSelect.setAttribute('label', 'Choose coverer');
    covererSelect.setAttribute('size', 's');
    // Any staff member can cover, not just floaters (field feedback). Floaters on
    // backup this slot are grouped first; the double-booking warning below flags
    // a pick who already has an overlapping shift.
    const floaterNames = [...new Set(getFreeFloaters(scheduleData, req.day, toMins(req.start_time)).map((r) => r.staff_name).filter(Boolean))]
      .filter((n) => n !== req.requester_name).sort();
    const floaterSet = new Set(floaterNames);
    const others = [...new Set(scheduleData.map((r) => r.staff_name).filter(Boolean))].sort()
      .filter((n) => !floaterSet.has(n) && n !== req.requester_name);
    const group = (title, names) => (names.length
      ? `<sp-menu-group><span slot="header">${title}</span>${names.map((n) => `<sp-menu-item value="${escapeHtml(n)}">${escapeHtml(n)}</sp-menu-item>`).join('')}</sp-menu-group>`
      : '');
    covererSelect.innerHTML = group('On backup now', floaterNames) + group('Everyone else', others);
    covererSelect.addEventListener('change', () => renderWarn(covererSelect.value));
    controls.append(covererSelect);
  } else {
    renderWarn(req.target_name);
  }
  card.append(warn);

  const approve = spButton('Approve', 'primary');
  const decline = spButton('Decline', 'secondary');
  controls.append(approve, decline);
  card.append(controls);

  const result = document.createElement('p');
  result.className = 'admin-request-result';
  card.append(result);

  approve.addEventListener('click', () => {
    const coverer = req.target_name || (covererSelect && covererSelect.value);
    if (!coverer) { result.dataset.kind = 'err'; result.textContent = 'Choose who will cover first.'; return; }
    approve.disabled = true; decline.disabled = true;
    resolveRequest(req, 'approve', coverer, result);
  });
  decline.addEventListener('click', () => {
    approve.disabled = true; decline.disabled = true;
    resolveRequest(req, 'decline', null, result);
  });

  return card;
}

let lastPendingCount = 0;
let lastSig = null;
let polledOnce = false;

// Visual + audible cue when new requests arrive during a poll.
function pingNewRequests() {
  requestsPanel.classList.add('admin-requests-flash');
  setTimeout(() => requestsPanel.classList.remove('admin-requests-flash'), 1200);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.05;
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch { /* audio is best-effort (autoplay policy) */ }
}

async function loadRequests(force = false) {
  try {
    const resp = await fetch(`/api/admin/requests?eventId=${eventId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) { if (force) requestsList.innerHTML = '<p class="hint">Could not load requests.</p>'; return; }
    const reqs = await resp.json();
    const list = Array.isArray(reqs) ? reqs : [];

    requestsBadge.hidden = list.length === 0;
    requestsBadge.textContent = String(list.length);
    if (polledOnce && list.length > lastPendingCount) pingNewRequests();
    lastPendingCount = list.length;
    polledOnce = true;

    // Only rebuild the DOM when the set of pending requests actually changed,
    // so a background poll never wipes an in-progress coverer selection.
    const sig = list.map((r) => r.id).sort().join(',');
    if (!force && sig === lastSig) return;
    lastSig = sig;

    if (!list.length) { requestsList.innerHTML = '<p class="hint">No pending requests.</p>'; return; }
    requestsList.innerHTML = '';
    list.forEach((req) => requestsList.append(renderRequest(req)));
  } catch {
    if (force) requestsList.innerHTML = '<p class="hint">Could not load requests.</p>';
  }
}

requestsRefresh.addEventListener('click', () => loadRequestContext().then(() => { loadRequests(true); loadRecent(); }));

// Recently applied changes (auto-applied accepts + admin-approved open asks).
async function loadRecent() {
  try {
    const resp = await fetch(`/api/admin/requests/recent?eventId=${eventId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return;
    const rows = await resp.json();
    if (!Array.isArray(rows) || !rows.length) { recentPanel.hidden = true; return; }
    recentPanel.hidden = false;
    recentList.innerHTML = '';
    rows.forEach((r) => {
      const d = document.createElement('div');
      d.className = 'admin-recent-row';
      d.textContent = `${r.coverer_name} now covers ${r.station} · ${r.day} ${r.requested_start || r.start_time}-${r.requested_end || r.end_time}`
        + (r.requester_name ? ` (was ${r.requester_name})` : '');
      recentList.append(d);
    });
  } catch { /* best-effort */ }
}

// --- web push opt-in (admin phone alerts) ---
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    pushBtn.textContent = 'Alerts not supported'; pushBtn.disabled = true; return;
  }
  pushBtn.disabled = true; pushBtn.textContent = 'Enabling…';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { pushBtn.textContent = 'Alerts blocked'; return; }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/push/vapid-public')).json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
    const resp = await fetch('/api/admin/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(sub),
    });
    // Tag this device so the service worker shows admin-style notifications.
    try { const c = await caches.open('push-meta'); await c.put('/__push_role', new Response('admin')); } catch { /* noop */ }
    pushBtn.textContent = resp.ok ? 'Phone alerts on ✓' : 'Try again';
    pushBtn.disabled = resp.ok;
  } catch {
    pushBtn.textContent = 'Try again'; pushBtn.disabled = false;
  }
}

pushBtn.addEventListener('click', enablePush);
if ('Notification' in window && Notification.permission === 'granted') {
  pushBtn.textContent = 'Phone alerts on ✓';
}
