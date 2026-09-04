import {
  fetchScheduleData, getZonedNow, escapeHtml, fmt12,
} from './time-utils.js';
import {
  getDaySlots, findSlotIdx, renderMySchedule, renderWhosOnNow,
} from './schedule.js';
import { initShiftChangeModal } from './coverage.js';

const eventId = new URLSearchParams(window.location.search).get('event') || 'ibc-2026';
const LS_NAME = 'staff-scheduler-name';

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

async function main() {
  const root = document.getElementById('app');

  let event;
  let data;
  try {
    event = await (await fetch(`/events/${eventId}.json`)).json();
    data = await fetchScheduleData(event.dataUrl);
  } catch (err) {
    root.innerHTML = `<p class="hint">Could not load "${eventId}" — ${err.message}</p>`;
    return;
  }

  document.title = `${event.name} · Schedule`;

  const names = [...new Set(data.map((r) => r.staff_name).filter(Boolean))].sort();
  let selectedName = '';
  try { selectedName = localStorage.getItem(LS_NAME) || ''; } catch { /* noop */ }
  let mode = 'my';

  root.innerHTML = `
    <header class="app-header">
      <div class="brand-row">
        <img class="brand-adobe-logo" src="/images/adobe-logo.svg" alt="Adobe">
        <span class="brand-divider" aria-hidden="true"></span>
        <img class="brand-ibc-logo" src="/images/ibc-logo-white.png" alt="IBC">
      </div>
      <h1>${escapeHtml(event.name)}</h1>
      <p class="app-sub">${escapeHtml(event.location || '')}</p>
    </header>
    <div class="toggle" role="group" aria-label="Schedule view">
      <button class="toggle-btn" data-mode="my">My Schedule</button>
      <button class="toggle-btn" data-mode="now">Who's On Now</button>
      <button class="toggle-btn" data-mode="contacts">Contacts</button>
    </div>
    <div class="panel panel-my">
      <div class="name-picker">
        <label class="name-label" for="name-input">Your name</label>
        <div class="name-input-wrap">
          <input type="text" class="name-input" id="name-input" placeholder="Search your name…" value="${escapeHtml(selectedName)}" autocomplete="off">
          <button class="name-clear" aria-label="Clear name" ${selectedName ? '' : 'hidden'}>✕</button>
          <ul class="name-suggestions" hidden></ul>
        </div>
        <button class="staff-alerts-btn" id="staff-alerts-btn" hidden>🔔 Enable phone alerts</button>
      </div>
      <div class="incoming-asks" id="incoming-asks"></div>
      <div class="my-requests" id="my-requests"></div>
      <div class="my-slots"></div>
    </div>
    <div class="panel panel-now">
      <div class="day-picker" role="group" aria-label="Select day"></div>
      <div class="now-content"></div>
    </div>
    <div class="panel panel-contacts">
      <div class="name-picker">
        <input type="text" class="name-input" id="contacts-search" placeholder="Search name or role…" autocomplete="off">
      </div>
      <div class="contacts-list" id="contacts-list"></div>
    </div>`;

  const myPanel = root.querySelector('.panel-my');
  const nowPanel = root.querySelector('.panel-now');
  const contactsPanel = root.querySelector('.panel-contacts');
  const mySlotsEl = root.querySelector('.my-slots');
  const incomingAsksEl = root.querySelector('#incoming-asks');
  const myRequestsEl = root.querySelector('#my-requests');
  const dayPicker = root.querySelector('.day-picker');
  const nowContentEl = root.querySelector('.now-content');
  const contactsListEl = root.querySelector('#contacts-list');
  const contactsSearch = root.querySelector('#contacts-search');
  const toggle = root.querySelector('.toggle');

  const zoned = getZonedNow(event.timezone);
  let displayDay = event.days.find((d) => d.date === zoned.dateStr)?.day || event.days[0].day;

  dayPicker.innerHTML = event.days.map(({ day }) => `<button class="day-btn${day === displayDay ? ' day-btn-active' : ''}" data-day="${day}" aria-label="${day}">${day.slice(0, 3)}</button>`).join('');

  function currentSlotIdx() {
    const slots = getDaySlots(data, displayDay);
    return slots.length ? findSlotIdx(slots, getZonedNow(event.timezone).totalMins) : 0;
  }

  dayPicker.querySelectorAll('.day-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      displayDay = btn.dataset.day;
      dayPicker.querySelectorAll('.day-btn').forEach((b) => b.classList.toggle('day-btn-active', b.dataset.day === displayDay));
      renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson);
    });
  });

  function showMode(m) {
    mode = m;
    toggle.querySelectorAll('.toggle-btn').forEach((btn) => btn.classList.toggle('toggle-active', btn.dataset.mode === mode));
    myPanel.classList.toggle('panel-hidden', mode !== 'my');
    nowPanel.classList.toggle('panel-hidden', mode !== 'now');
    contactsPanel.classList.toggle('panel-hidden', mode !== 'contacts');
    if (mode === 'my') { loadIncomingAsks(selectedName); loadMyRequests(selectedName); }
    if (mode === 'now') renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson);
    if (mode === 'contacts') loadDirectory();
  }

  // Staff-facing directory: tap-to-Slack (LDAP handle from email), tap-to-call,
  // email. Fetched once, then filtered client-side.
  let directory = null;
  const handleFromEmail = (email) => (email ? `@${email.split('@')[0]}` : '');

  function renderContacts(filter) {
    const q = (filter || '').trim().toLowerCase();
    const rows = directory.filter((c) => !q
      || (c.name && c.name.toLowerCase().includes(q))
      || (c.title && c.title.toLowerCase().includes(q)));
    if (!rows.length) { contactsListEl.innerHTML = '<p class="hint">No matches.</p>'; return; }
    contactsListEl.innerHTML = rows.map((c) => {
      const handle = c.slack || handleFromEmail(c.email);
      const slackBtn = handle
        ? `<a class="contact-btn contact-slack" href="https://slack.com/app_redirect?channel=${encodeURIComponent(handle)}" target="_blank" rel="noopener">Slack</a>`
        : '';
      const phoneBtn = c.phone
        ? `<a class="contact-btn contact-phone" href="tel:${escapeHtml(c.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(c.phone)}</a>`
        : '';
      const emailBtn = c.email
        ? `<a class="contact-btn contact-email" href="mailto:${escapeHtml(c.email)}" aria-label="Email ${escapeHtml(c.name)}">Email</a>`
        : '';
      return `<div class="contact-row">
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name)}</div>
          ${c.title ? `<div class="contact-title">${escapeHtml(c.title)}</div>` : ''}
          ${handle ? `<div class="contact-handle">${escapeHtml(handle)}</div>` : ''}
        </div>
        <div class="contact-actions">${slackBtn}${phoneBtn}${emailBtn}</div>
      </div>`;
    }).join('');
  }

  async function loadDirectory() {
    if (directory) { renderContacts(contactsSearch.value); return; }
    contactsListEl.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const resp = await fetch(`/api/directory/${eventId}`);
      directory = resp.ok ? await resp.json() : [];
      renderContacts(contactsSearch.value);
    } catch {
      contactsListEl.innerHTML = '<p class="hint">Could not load contacts.</p>';
    }
  }

  contactsSearch.addEventListener('input', () => { if (directory) renderContacts(contactsSearch.value); });

  toggle.querySelectorAll('.toggle-btn').forEach((btn) => btn.addEventListener('click', () => showMode(btn.dataset.mode)));

  const nameInput = myPanel.querySelector('.name-input');
  const clearBtn = myPanel.querySelector('.name-clear');
  const suggestionsEl = myPanel.querySelector('.name-suggestions');
  const staffAlertsBtn = myPanel.querySelector('#staff-alerts-btn');

  const shiftChangeModal = initShiftChangeModal(data, event);
  const onRequestChange = (slot) => shiftChangeModal.open(slot, selectedName);

  function applyName(val) {
    const name = val.trim();
    selectedName = name;
    try { if (name) localStorage.setItem(LS_NAME, name); else localStorage.removeItem(LS_NAME); } catch { /* noop */ }
    clearBtn.hidden = !name;
    staffAlertsBtn.hidden = !name;
    renderMySchedule(mySlotsEl, data, selectedName, event, onRequestChange);
    loadIncomingAsks(selectedName);
    loadMyRequests(selectedName);
  }

  // Staff opt-in to phone push, keyed to their name, so a directed ask buzzes them.
  async function enableStaffPush() {
    const name = selectedName;
    if (!name) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      staffAlertsBtn.textContent = 'Alerts not supported'; staffAlertsBtn.disabled = true; return;
    }
    staffAlertsBtn.disabled = true; staffAlertsBtn.textContent = 'Enabling…';
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { staffAlertsBtn.textContent = 'Alerts blocked'; return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/api/push/vapid-public')).json();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) });
      const resp = await fetch('/api/push/subscribe/staff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub, name }),
      });
      try { const c = await caches.open('push-meta'); await c.put('/__push_role', new Response('staff')); } catch { /* noop */ }
      staffAlertsBtn.textContent = resp.ok ? '🔔 Alerts on ✓' : 'Try again';
      staffAlertsBtn.disabled = resp.ok;
    } catch { staffAlertsBtn.textContent = 'Try again'; staffAlertsBtn.disabled = false; }
  }
  staffAlertsBtn.addEventListener('click', enableStaffPush);

  // Auto-prompt for alerts the first time someone picks their name (a real user
  // gesture), so they don't have to hunt for the button. Only when undecided.
  function autoPromptAlerts() {
    if (selectedName && 'Notification' in window && 'PushManager' in window && Notification.permission === 'default') {
      enableStaffPush();
    }
  }

  // Directed asks waiting for THIS person to accept/decline (shown atop My Schedule).
  async function respondAsk(id, action, name) {
    const res = incomingAsksEl.querySelector(`[data-res="${id}"]`);
    if (res) res.textContent = action === 'accept' ? 'Accepting…' : 'Declining…';
    try {
      const resp = await fetch('/api/requests/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(id), name, action }),
      });
      const dataRes = await resp.json();
      if (resp.ok) loadIncomingAsks(name);
      else if (res) res.textContent = dataRes.error || 'Failed.';
    } catch { if (res) res.textContent = 'Network error.'; }
  }

  async function loadIncomingAsks(name) {
    if (!name) { incomingAsksEl.innerHTML = ''; return; }
    try {
      const asks = await (await fetch(`/api/requests/for?eventId=${eventId}&name=${encodeURIComponent(name)}`)).json();
      if (!Array.isArray(asks) || !asks.length) { incomingAsksEl.innerHTML = ''; return; }
      incomingAsksEl.innerHTML = asks.map((a) => `<div class="ask-card">
        <div class="ask-title">${escapeHtml(a.requester_name)} asked you to cover</div>
        <div class="ask-sub">${escapeHtml(a.station)} · ${escapeHtml(a.day)} ${fmt12(a.start_time)}–${fmt12(a.end_time)}</div>
        <div class="ask-actions">
          <button class="ask-accept" data-id="${a.id}">Accept</button>
          <button class="ask-decline" data-id="${a.id}">Decline</button>
        </div>
        <p class="ask-result" data-res="${a.id}"></p>
      </div>`).join('');
      incomingAsksEl.querySelectorAll('.ask-accept, .ask-decline').forEach((btn) => {
        btn.addEventListener('click', () => respondAsk(btn.dataset.id, btn.classList.contains('ask-accept') ? 'accept' : 'decline', name));
      });
    } catch { incomingAsksEl.innerHTML = ''; }
  }

  // The requester's own outgoing requests + their state (so a decline/approval
  // is visible in-app even without push).
  async function loadMyRequests(name) {
    if (!name) { myRequestsEl.innerHTML = ''; return; }
    try {
      const rows = await (await fetch(`/api/requests/mine?eventId=${eventId}&name=${encodeURIComponent(name)}`)).json();
      if (!Array.isArray(rows) || !rows.length) { myRequestsEl.innerHTML = ''; return; }
      myRequestsEl.innerHTML = rows.map((r) => {
        const who = escapeHtml(r.target_name || 'anyone');
        const shift = `${escapeHtml(r.station)} · ${escapeHtml(r.day)} ${fmt12(r.start_time)}–${fmt12(r.end_time)}`;
        let state = r.status;
        if (r.status === 'awaiting_target') state = `waiting for ${who} to respond`;
        else if (r.status === 'awaiting_admin') state = `${who} accepted — waiting for admin approval`;
        else if (r.status === 'declined_by_target') state = `${who} declined — ask someone else`;
        else if (r.status === 'approved') state = `covered by ${escapeHtml(r.coverer_name || r.target_name || 'someone')} ✓`;
        return `<div class="myreq-card myreq-${r.status}">
          <div class="myreq-shift">Your change request: ${shift}</div>
          <div class="myreq-state">${state}</div>
        </div>`;
      }).join('');
    } catch { myRequestsEl.innerHTML = ''; }
  }

  function onSelectPerson(name) {
    nameInput.value = name;
    applyName(name);
    showMode('my');
    autoPromptAlerts();
  }

  function buildSuggestions(filtered) {
    if (!filtered.length) { suggestionsEl.hidden = true; return; }
    suggestionsEl.innerHTML = filtered.map((n) => `<li class="name-option" data-name="${escapeHtml(n)}">${escapeHtml(n)}</li>`).join('');
    suggestionsEl.hidden = false;
  }

  nameInput.addEventListener('focus', () => {
    const q = nameInput.value.trim().toLowerCase();
    buildSuggestions(q ? names.filter((n) => n.toLowerCase().includes(q)) : names);
  });
  nameInput.addEventListener('input', () => {
    clearBtn.hidden = !nameInput.value.trim();
    const q = nameInput.value.trim().toLowerCase();
    buildSuggestions(q ? names.filter((n) => n.toLowerCase().includes(q)) : names);
  });
  nameInput.addEventListener('blur', () => setTimeout(() => { suggestionsEl.hidden = true; }, 150));
  suggestionsEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.name-option');
    if (opt) { nameInput.value = opt.dataset.name; applyName(opt.dataset.name); suggestionsEl.hidden = true; autoPromptAlerts(); }
  });
  clearBtn.addEventListener('click', () => { nameInput.value = ''; applyName(''); nameInput.focus(); });

  staffAlertsBtn.hidden = !selectedName;
  renderMySchedule(mySlotsEl, data, selectedName, event, onRequestChange);
  showMode(mode);

  setInterval(() => {
    if (mode === 'my') { renderMySchedule(mySlotsEl, data, selectedName, event, onRequestChange); loadIncomingAsks(selectedName); loadMyRequests(selectedName); }
    if (mode === 'now') renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson);
  }, 60_000);
}

main();
