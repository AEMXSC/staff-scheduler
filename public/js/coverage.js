import {
  getZonedNow, toMins, fmt12, escapeHtml,
} from './time-utils.js';

const LS_NAME = 'staff-scheduler-name';

function findCurrentAssignment(data, name, event) {
  const zoned = getZonedNow(event.timezone);
  const dayName = event.days.find((d) => d.date === zoned.dateStr)?.day;
  if (!dayName || !name) return null;

  return data.find((r) => r.staff_name === name
    && r.day === dayName
    && zoned.totalMins >= toMins(r.start_time)
    && zoned.totalMins < toMins(r.end_time)) || null;
}

function buildCoverageMessage(name, assignment) {
  if (!assignment) {
    return `🔴 COVERAGE NEEDED: ${name || 'Someone'} needs coverage. Can anyone help?`;
  }
  const time = `${fmt12(assignment.start_time)}–${fmt12(assignment.end_time)}`;
  return `🔴 COVERAGE NEEDED: ${name} at ${assignment.station} — ${time}. Can anyone cover?`;
}

function openSlack(channel, message) {
  const encoded = encodeURIComponent(message);
  const deeplink = channel
    ? `slack://app_redirect?channel=${encodeURIComponent(channel)}&message=${encoded}`
    : null;
  const weblink = channel
    ? `https://slack.com/app_redirect?channel=${encodeURIComponent(channel)}`
    : 'https://slack.com';

  if (deeplink) {
    const start = Date.now();
    window.location.href = deeplink;
    setTimeout(() => {
      if (Date.now() - start < 2000) window.open(weblink, '_blank');
    }, 1500);
  } else {
    window.open(weblink, '_blank');
  }
}

export function initCoverageFab(data, event) {
  const fab = document.createElement('button');
  fab.className = 'coverage-fab';
  fab.setAttribute('aria-label', 'Request coverage');
  fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  document.body.append(fab);

  const modal = document.createElement('div');
  modal.className = 'coverage-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'coverage-title');
  modal.hidden = true;
  modal.innerHTML = `
    <div class="coverage-backdrop"></div>
    <div class="coverage-sheet">
      <h2 class="coverage-title" id="coverage-title">Need Coverage?</h2>
      <div class="coverage-context" id="cov-context"></div>
      <label class="coverage-msg-label" for="cov-msg">Message</label>
      <textarea class="coverage-msg" id="cov-msg" rows="3"></textarea>
      <button class="coverage-send" id="cov-send">Send to Slack Channel</button>
      <button class="coverage-copy" id="cov-copy">Copy message instead</button>
      <button class="coverage-close" aria-label="Close">✕</button>
    </div>`;
  document.body.append(modal);

  const contextEl = modal.querySelector('#cov-context');
  const msgEl = modal.querySelector('#cov-msg');
  const sendBtn = modal.querySelector('#cov-send');
  const copyBtn = modal.querySelector('#cov-copy');
  const closeBtn = modal.querySelector('.coverage-close');
  const backdrop = modal.querySelector('.coverage-backdrop');

  function openModal() {
    let name = '';
    try { name = localStorage.getItem(LS_NAME) || ''; } catch { /* noop */ }

    const assignment = findCurrentAssignment(data, name, event);
    const message = buildCoverageMessage(name, assignment);

    if (assignment) {
      contextEl.innerHTML = `<div><strong>${escapeHtml(name)}</strong></div>
        <div>${escapeHtml(assignment.station)}</div>
        <div>${fmt12(assignment.start_time)}–${fmt12(assignment.end_time)}</div>`;
    } else if (name) {
      contextEl.innerHTML = `<div><strong>${escapeHtml(name)}</strong> — no active slot right now</div>`;
    } else {
      contextEl.innerHTML = '<div class="hint">Select your name in My Schedule first</div>';
    }

    msgEl.value = message;
    modal.hidden = false;
    msgEl.focus();
  }

  function closeModal() {
    modal.hidden = true;
    fab.focus();
  }

  fab.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  sendBtn.addEventListener('click', () => openSlack(event.slackChannelId, msgEl.value));

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(msgEl.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy message instead'; }, 2000);
    } catch {
      msgEl.select();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
}

export { LS_NAME };
