import '/vendor/spectrum.js';
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
const LS_ALERTS = `staff-scheduler-alerts:${eventId}`; // whose name this device's alerts are under

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
          <sp-status-light size="s" variant="${{ live: 'positive', upcoming: 'notice' }[status.kind] || 'neutral'}">${escapeHtml(status.text)}</sp-status-light>
        </div>
      </div>
    </header>
    <sp-tabs class="toggle" selected="my" label="Schedule view">
      <sp-tab value="my" label="My Shifts"><sp-icon-calendar slot="icon"></sp-icon-calendar></sp-tab>
      <sp-tab value="now" label="On Now"><sp-icon-people slot="icon"></sp-icon-people></sp-tab>
      <sp-tab value="contacts" label="Contacts"><sp-icon-device-phone slot="icon"></sp-icon-device-phone></sp-tab>
    </sp-tabs>
    <div class="panel panel-my">
      <div class="name-picker">
        <sp-field-label for="name-input">Your name</sp-field-label>
        <div class="name-input-wrap">
          <sp-search class="name-input" id="name-input" label="Your name" placeholder="Search your name" value="${escapeHtml(selectedName)}"></sp-search>
          <sp-menu class="name-suggestions" label="Staff names" hidden></sp-menu>
        </div>
        <sp-button class="staff-alerts-btn" id="staff-alerts-btn" variant="secondary" treatment="outline" hidden><sp-icon-bell slot="icon"></sp-icon-bell><span>Enable phone alerts</span></sp-button>
        <p class="hint alerts-hint" id="alerts-hint" hidden></p>
      </div>
      <div class="incoming-asks" id="incoming-asks"></div>
      <div class="my-requests" id="my-requests"></div>
      <div class="my-slots"></div>
    </div>
    <div class="panel panel-now">
      <sp-action-group class="day-picker" justified label="Select day"></sp-action-group>
      <div class="now-content"></div>
    </div>
    <div class="panel panel-contacts">
      <div class="name-picker">
        <sp-search id="contacts-search" label="Search contacts" placeholder="Search name or role"></sp-search>
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

  dayPicker.innerHTML = event.days.map(({ day }) => `<sp-action-button class="day-btn"${day === displayDay ? ' selected' : ''} data-day="${day}" label="${day}">${day.slice(0, 3)}</sp-action-button>`).join('');

  function currentSlotIdx() {
    const slots = getDaySlots(data, displayDay);
    return slots.length ? findSlotIdx(slots, getZonedNow(event.timezone).totalMins) : 0;
  }

  dayPicker.querySelectorAll('.day-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      displayDay = btn.dataset.day;
      dayPicker.querySelectorAll('.day-btn').forEach((b) => { b.selected = b.dataset.day === displayDay; });
      renderWhosOnNow(nowContentEl, data, displayDay, currentSlotIdx(), onSelectPerson, event);
    });
  });

  function showMode(m) {
    mode = m;
    toggle.selected = mode;
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
        ? `<sp-button size="s" variant="secondary" treatment="outline" href="https://slack.com/app_redirect?channel=${encodeURIComponent(handle)}" target="_blank" rel="noopener">Slack</sp-button>`
        : '';
      const phoneBtn = c.phone
        ? `<sp-button size="s" variant="secondary" treatment="outline" href="tel:${escapeHtml(c.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(c.phone)}</sp-button>`
        : '';
      const emailBtn = c.email
        ? `<sp-button size="s" variant="secondary" treatment="outline" href="mailto:${escapeHtml(c.email)}" label="Email ${escapeHtml(c.name)}">Email</sp-button>`
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

  toggle.addEventListener('change', () => showMode(toggle.selected));
  // sp-search would otherwise submit its internal form and reload the page.
  root.querySelectorAll('sp-search').forEach((s) => s.addEventListener('submit', (e) => e.preventDefault()));

  const nameInput = myPanel.querySelector('.name-input');
  const suggestionsEl = myPanel.querySelector('.name-suggestions');
  const staffAlertsBtn = myPanel.querySelector('#staff-alerts-btn');
  const alertsHint = myPanel.querySelector('#alerts-hint');

  // Set "shiftChangeRequests": false in an event's JSON to turn off staff change
  // requests; alerts then announce admin changes instead. Delete it to restore.
  const requestsEnabled = event.shiftChangeRequests !== false;
  const shiftChangeModal = requestsEnabled ? initShiftChangeModal(data, event) : null;
  const onRequestChange = requestsEnabled ? (slot) => shiftChangeModal.open(slot, selectedName) : null;

  function applyName(val) {
    const name = val.trim();
    selectedName = name;
    try { if (name) localStorage.setItem(LS_NAME, name); else localStorage.removeItem(LS_NAME); } catch { /* noop */ }
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
        // eventId opts this device into admin-change alerts, whose wording needs the role below.
        body: JSON.stringify({ subscription: sub, name, ...(requestsEnabled ? {} : { eventId }) }),
      });
      try { const c = await caches.open('push-meta'); await c.put('/__push_role', new Response(requestsEnabled ? 'staff' : 'staff-updates')); } catch { /* noop */ }
      if (resp.ok) { try { localStorage.setItem(LS_ALERTS, name); } catch { /* noop */ } }
      label.textContent = resp.ok ? 'Alerts on' : 'Try again';
      staffAlertsBtn.disabled = resp.ok;
    } catch { label.textContent = 'Try again'; staffAlertsBtn.disabled = false; }
  }
  staffAlertsBtn.addEventListener('click', enableStaffPush);

  // Show "Alerts on" only if this device is still subscribed under the selected name.
  async function syncAlertsOn() {
    const name = selectedName;
    let on = false;
    try {
      if (name && Notification.permission === 'granted' && localStorage.getItem(LS_ALERTS) === name) {
        const reg = await navigator.serviceWorker.getRegistration();
        on = !!(await reg?.pushManager.getSubscription());
      }
    } catch { /* not supported here: leave the button offering to enable */ }
    if (name !== selectedName) return; // the name changed while checking
    staffAlertsBtn.querySelector('span').textContent = on ? 'Alerts on' : 'Enable phone alerts';
    staffAlertsBtn.disabled = on;
  }

  const syncAlertsBlocked = () => {
    if (selectedName && 'Notification' in window && Notification.permission === 'denied') showAlertsBlocked();
    else { alertsHint.hidden = true; syncAlertsOn(); }
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
    if (!name || !requestsEnabled) { incomingAsksEl.innerHTML = ''; return; }
    try {
      const asks = await (await fetch(`/api/requests/for?eventId=${eventId}&name=${encodeURIComponent(name)}`)).json();
      if (!Array.isArray(asks) || !asks.length) { incomingAsksEl.innerHTML = ''; return; }
      incomingAsksEl.innerHTML = asks.map((a) => `<div class="ask-card">
        <div class="ask-title">${escapeHtml(a.requester_name)} asked you to cover</div>
        <div class="ask-sub">${escapeHtml(a.station)} · ${escapeHtml(a.day)} ${fmt12(a.requested_start || a.start_time)}–${fmt12(a.requested_end || a.end_time)}</div>
        <div class="ask-actions">
          <sp-button class="ask-accept" variant="primary" data-id="${a.id}">Accept</sp-button>
          <sp-button class="ask-decline" variant="secondary" treatment="outline" data-id="${a.id}">Decline</sp-button>
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
    if (!name || !requestsEnabled) { myRequestsEl.innerHTML = ''; return; }
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
    suggestionsEl.innerHTML = filtered.map((n) => `<sp-menu-item class="name-option" data-name="${escapeHtml(n)}">${escapeHtml(n)}</sp-menu-item>`).join('');
    suggestionsEl.hidden = false;
  }

  nameInput.addEventListener('focusin', () => {
    clearTimeout(hideTimer);
    const q = nameInput.value.trim().toLowerCase();
    buildSuggestions(q ? names.filter((n) => n.toLowerCase().includes(q)) : names);
  });
  nameInput.addEventListener('input', () => {
    const q = nameInput.value.trim().toLowerCase();
    if (!q && selectedName) applyName(''); // the search field's clear button
    buildSuggestions(q ? names.filter((n) => n.toLowerCase().includes(q)) : names);
  });
  let hideTimer = null;
  nameInput.addEventListener('focusout', (e) => {
    if (suggestionsEl.contains(e.relatedTarget)) return;
    hideTimer = setTimeout(() => { suggestionsEl.hidden = true; }, 150);
  });
  const pickSuggestion = (e) => {
    const opt = e.target.closest('.name-option');
    if (opt) { nameInput.value = opt.dataset.name; applyName(opt.dataset.name); suggestionsEl.hidden = true; autoPromptAlerts(); }
  };
  suggestionsEl.addEventListener('mousedown', pickSuggestion);
  suggestionsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pickSuggestion(e); });

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

  // Coming back to an app left open: reload only if the schedule actually changed,
  // and not mid-request or mid-name-search (the next return checks again).
  const loadedSchedule = JSON.stringify(data);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const latest = await fetchScheduleData(event.dataUrl);
      const busy = document.querySelector('.coverage-modal:not([hidden])') || nameInput.matches(':focus-within');
      if (!busy && JSON.stringify(latest) !== loadedSchedule) location.reload();
    } catch { /* offline: keep what's on screen */ }
  });
}

main();
