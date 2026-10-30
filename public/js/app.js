import {
  fetchScheduleData, getZonedNow, escapeHtml, fmt12, getEventStatus, formatDateRange,
} from './time-utils.js';
import {
  getDaySlots, findSlotIdx, renderMySchedule, renderWhosOnNow,
} from './schedule.js';
import { initShiftChangeModal } from './coverage.js';
import { resolveEventId, applyTheme, eventLogo } from './event-config.js';

const eventId = resolveEventId();
// Per-event so a shared origin (preview/localhost/?event= switching) doesn't
// read back the other event's selected name.
const LS_NAME = `staff-scheduler-name:${eventId}`;

// Inline SVG icons (Lucide-style strokes) instead of emoji, per Spectrum.
const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  people: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  phone: svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
};

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

  applyTheme(event);
  const logo = eventLogo(event);
  // A full "Adobe MAX" wordmark already says Adobe + the event name, so skip the
  // separate Adobe mark and the visible h1 rather than branding three times.
  const logoHasAdobe = !!event.branding?.logoIncludesAdobe;

  const names = [...new Set(data.map((r) => r.staff_name).filter(Boolean))].sort();
  let selectedName = '';
  try { selectedName = localStorage.getItem(LS_NAME) || ''; } catch { /* noop */ }
  if (selectedName && !names.includes(selectedName)) selectedName = ''; // stale/other-event name
  let mode = 'my';

  const status = getEventStatus(event.days, event.timezone);
  const dateRange = formatDateRange(event.days);

  root.innerHTML = `
    <header class="app-header">
      <div class="header-inner">
        <div class="header-brand">
          <div class="brand-row">
            ${logoHasAdobe ? '' : `<img class="brand-adobe-logo" src="/images/adobe-logo.svg" alt="Adobe">
            <span class="brand-divider" aria-hidden="true"></span>`}
            <img class="brand-ibc-logo" src="${escapeHtml(logo.src)}" alt="${escapeHtml(logo.alt)}">
          </div>
          <h1${logoHasAdobe ? ' class="sr-only"' : ''}>${escapeHtml(event.name)}</h1>
          <p class="app-sub">${logoHasAdobe ? 'Staff Schedule · ' : ''}${escapeHtml(event.location || '')} · ${escapeHtml(dateRange)}</p>
        </div>
        <div class="header-status">
          <span class="status-dot status-dot--${status.kind}" aria-hidden="true"></span>
          <span class="status-text status-text--${status.kind}">${escapeHtml(status.text)}</span>
        </div>
      </div>
    </header>
    <nav class="toggle" aria-label="Schedule view">
      <button class="toggle-btn" data-mode="my">${ICONS.calendar}<span>My Shifts</span></button>
      <button class="toggle-btn" data-mode="now">${ICONS.people}<span>On Now</span></button>
      <button class="toggle-btn" data-mode="contacts">${ICONS.phone}<span>Contacts</span></button>
    </nav>
    <div class="panel panel-my">
      <div class="name-picker">
        <label class="name-label" for="name-input">Your name</label>
        <div class="name-input-wrap">
          <input type="text" class="name-input" id="name-input" placeholder="Search your name…" value="${escapeHtml(selectedName)}" autocomplete="off">
          <button class="name-clear" aria-label="Clear name" ${selectedName ? '' : 'hidden'}>✕</button>
          <ul class="name-suggestions" hidden></ul>
        </div>
        <button class="staff-alerts-btn" id="staff-alerts-btn" hidden>${ICONS.bell}<span>Enable phone alerts</span></button>
        <p class="hint alerts-hint" id="alerts-hint" hidden></p>
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
      renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson, event);
    });
  });

  function showMode(m) {
    mode = m;
    toggle.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.classList.toggle('toggle-active', btn.dataset.mode === mode);
      if (btn.dataset.mode === mode) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    myPanel.classList.toggle('panel-hidden', mode !== 'my');
    nowPanel.classList.toggle('panel-hidden', mode !== 'now');
    contactsPanel.classList.toggle('panel-hidden', mode !== 'contacts');
    if (mode === 'my') { loadIncomingAsks(selectedName); loadMyRequests(selectedName); }
    if (mode === 'now') renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson, event);
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
    if (!rows.length) { contactsListEl.innerHTML = `<p class="hint">${directory.length ? 'No matches.' : "Contacts haven't been added yet."}</p>`; return; }
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
  const alertsHint = myPanel.querySelector('#alerts-hint');

  const shiftChangeModal = initShiftChangeModal(data, event);
  const onRequestChange = (slot) => shiftChangeModal.open(slot, selectedName);

  function applyName(val) {
    const name = val.trim();
    selectedName = name;
    try { if (name) localStorage.setItem(LS_NAME, name); else localStorage.removeItem(LS_NAME); } catch { /* noop */ }
    clearBtn.hidden = !name;
    staffAlertsBtn.hidden = !name;
    syncAlertsBlocked();
    renderMySchedule(mySlotsEl, data, selectedName, event, onRequestChange);
    loadIncomingAsks(selectedName);
    loadMyRequests(selectedName);
  }

  function showAlertsBlocked() {
    staffAlertsBtn.querySelector('span').textContent = 'Alerts blocked';
    staffAlertsBtn.disabled = false;
    alertsHint.textContent = 'Your browser is blocking alerts for this site. Open the site settings (the icon next to the web address), set Notifications to Allow, reload, and tap this button again.';
    alertsHint.hidden = false;
  }

  // Staff opt-in to phone push, keyed to their name, so a directed ask buzzes them.
  async function enableStaffPush() {
    const name = selectedName;
    if (!name) return;
    const label = staffAlertsBtn.querySelector('span');
    alertsHint.hidden = true;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      label.textContent = 'Alerts not available here';
      alertsHint.textContent = 'On iPhone: tap Share, then Add to Home Screen, open the app from there, and tap this button again.';
      alertsHint.hidden = false;
      return;
    }
    staffAlertsBtn.disabled = true; label.textContent = 'Enabling…';
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'denied') { showAlertsBlocked(); return; }
      // Closing the prompt without answering isn't a refusal; let them try again.
      if (perm !== 'granted') { label.textContent = 'Enable phone alerts'; staffAlertsBtn.disabled = false; return; }
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
      label.textContent = resp.ok ? 'Alerts on' : 'Try again';
      staffAlertsBtn.disabled = resp.ok;
    } catch { label.textContent = 'Try again'; staffAlertsBtn.disabled = false; }
  }
  staffAlertsBtn.addEventListener('click', enableStaffPush);
  const syncAlertsBlocked = () => {
    if (selectedName && 'Notification' in window && Notification.permission === 'denied') showAlertsBlocked();
    else alertsHint.hidden = true;
  };
  syncAlertsBlocked();

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
        <div class="ask-sub">${escapeHtml(a.station)} · ${escapeHtml(a.day)} ${fmt12(a.requested_start || a.start_time)}–${fmt12(a.requested_end || a.end_time)}</div>
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
        // Show the window the requester actually asked to hand off, not the full
        // shift (falls back to the full shift for legacy rows with no window).
        const covStart = r.requested_start || r.start_time;
        const covEnd = r.requested_end || r.end_time;
        const shift = `${escapeHtml(r.station)} · ${escapeHtml(r.day)} ${fmt12(covStart)}–${fmt12(covEnd)}`;
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
    // Don't re-render Who's-On-Now while the user is typing in the filter (it
    // would rebuild the input and lose focus mid-keystroke).
    // Also skip while anything inside the panel has focus (area toggles, chips,
    // nav buttons) -- rebuilding the DOM would drop focus and a mid-tap press.
    if (mode === 'now' && !nowContentEl.contains(document.activeElement)) {
      renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson, event);
    }
  }, 60_000);
}

main();
