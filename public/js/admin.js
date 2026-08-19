const eventId = new URLSearchParams(window.location.search).get('event') || 'ibc-2026';
const SESSION_KEY = 'staff-scheduler-admin-token';

const root = document.getElementById('admin-app');
root.innerHTML = `
  <header class="app-header">
    <div class="brand-row">
      <img class="brand-adobe-logo" src="/images/adobe-logo.svg" alt="Adobe">
      <span class="brand-divider" aria-hidden="true"></span>
      <img class="brand-ibc-logo" src="/images/ibc-logo-white.png" alt="IBC">
    </div>
    <h1>Schedule Admin</h1>
    <p class="app-sub">Ask questions or request changes — nothing is applied until you confirm it.</p>
  </header>
  <div class="admin-auth" id="admin-auth">
    <label class="name-label" for="admin-pass">Passphrase</label>
    <div class="admin-auth-row">
      <input type="password" id="admin-pass" class="name-input" autocomplete="off">
      <button class="admin-unlock-btn" id="admin-unlock">Unlock</button>
    </div>
    <p class="hint" id="admin-auth-hint"></p>
  </div>
  <div class="admin-chat" id="admin-chat" hidden>
    <div class="admin-messages" id="admin-messages"></div>
    <div class="admin-input-bar">
      <textarea id="admin-textarea" class="admin-textarea" rows="1" placeholder="Ask about or change the schedule…"></textarea>
      <button id="admin-send" class="admin-send-btn" disabled>Send</button>
    </div>
  </div>`;

const authEl = document.getElementById('admin-auth');
const passInput = document.getElementById('admin-pass');
const unlockBtn = document.getElementById('admin-unlock');
const authHint = document.getElementById('admin-auth-hint');
const chatEl = document.getElementById('admin-chat');
const messagesEl = document.getElementById('admin-messages');
const textarea = document.getElementById('admin-textarea');
const sendBtn = document.getElementById('admin-send');

let token = '';
try { token = sessionStorage.getItem(SESSION_KEY) || ''; } catch { /* noop */ }

function showChat() {
  authEl.hidden = true;
  chatEl.hidden = false;
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
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'admin-confirm-btn';
  confirmBtn.textContent = 'Confirm';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'admin-cancel-btn';
  cancelBtn.textContent = 'Cancel';

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
  textarea.style.height = 'auto';
  sendBtn.disabled = true;

  const thinking = addMessage('ai', '…');

  try {
    const resp = await fetch('/api/admin/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, eventId }),
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
  } catch {
    thinking.remove();
    addMessage('ai', '⚠ Network error.');
  }
}

textarea.addEventListener('input', () => {
  sendBtn.disabled = !textarea.value.trim();
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
});
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);
