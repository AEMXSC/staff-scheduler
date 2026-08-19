import {
  getZonedNow, toMins, fmt12, escapeHtml, timeRangeSteps,
} from './time-utils.js';
import { getFreeFloaters } from './schedule.js';

const LS_NAME = 'staff-scheduler-name';

function findCurrentAssignment(data, name, event) {
  const zoned = getZonedNow(event.timezone);
  const dayName = event.days.find((d) => d.date === zoned.dateStr)?.day;
  if (!dayName || !name) return null;

  const assignment = data.find((r) => r.staff_name === name
    && r.day === dayName
    && zoned.totalMins >= toMins(r.start_time)
    && zoned.totalMins < toMins(r.end_time)) || null;

  return assignment ? { ...assignment, dayName } : null;
}

// "asking <target>" for a directed request; falls back to today's open
// broadcast wording when no specific person is chosen.
function buildShiftChangeMessage(name, assignment, windowStart, windowEnd, target) {
  if (!assignment) {
    return `🔴 COVERAGE NEEDED: ${name || 'Someone'} needs coverage. Can anyone help?`;
  }
  const time = `${fmt12(windowStart)}–${fmt12(windowEnd)}`;
  if (target) {
    return `🔄 SHIFT CHANGE: ${name} needs ${assignment.station} covered ${time} — asking ${target}.`;
  }
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

export function initShiftChangeFab(data, event) {
  const fab = document.createElement('button');
  fab.className = 'coverage-fab';
  fab.setAttribute('aria-label', 'Request shift change');
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
      <h2 class="coverage-title" id="coverage-title">Request Shift Change</h2>
      <div class="coverage-context" id="cov-context"></div>
      <div class="cov-window-row" id="cov-window-row" hidden>
        <div class="cov-field">
          <label for="cov-start">From</label>
          <select id="cov-start"></select>
        </div>
        <div class="cov-field">
          <label for="cov-end">To</label>
          <select id="cov-end"></select>
        </div>
      </div>
      <div class="cov-field" id="cov-target-row" hidden>
        <label for="cov-target">Ask</label>
        <select id="cov-target"></select>
      </div>
      <label class="coverage-msg-label" for="cov-msg">Message</label>
      <textarea class="coverage-msg" id="cov-msg" rows="3"></textarea>
      <button class="coverage-send" id="cov-send">Send to Slack Channel</button>
      <button class="coverage-copy" id="cov-copy">Copy message instead</button>
      <button class="coverage-close" aria-label="Close">✕</button>
    </div>`;
  document.body.append(modal);

  const contextEl = modal.querySelector('#cov-context');
  const windowRow = modal.querySelector('#cov-window-row');
  const startSel = modal.querySelector('#cov-start');
  const endSel = modal.querySelector('#cov-end');
  const targetRow = modal.querySelector('#cov-target-row');
  const targetSel = modal.querySelector('#cov-target');
  const msgEl = modal.querySelector('#cov-msg');
  const sendBtn = modal.querySelector('#cov-send');
  const copyBtn = modal.querySelector('#cov-copy');
  const closeBtn = modal.querySelector('.coverage-close');
  const backdrop = modal.querySelector('.coverage-backdrop');

  let currentName = '';
  let currentAssignment = null;
  let steps = [];

  function refreshMessage() {
    msgEl.value = buildShiftChangeMessage(
      currentName,
      currentAssignment,
      startSel.value,
      endSel.value,
      targetSel.value,
    );
  }

  function populateTargetOptions() {
    const names = [...new Set(
      getFreeFloaters(data, currentAssignment.dayName, toMins(startSel.value)).map((r) => r.staff_name),
    )];
    targetSel.innerHTML = ['<option value="">Anyone / open ask</option>']
      .concat(names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`))
      .join('');
  }

  function populateEndOptions() {
    const options = steps.filter((t) => toMins(t) > toMins(startSel.value));
    endSel.innerHTML = options.map((t) => `<option value="${t}">${fmt12(t)}</option>`).join('');
    endSel.value = currentAssignment.end_time;
  }

  function onStartChange() {
    populateEndOptions();
    populateTargetOptions();
    refreshMessage();
  }

  startSel.addEventListener('change', onStartChange);
  endSel.addEventListener('change', refreshMessage);
  targetSel.addEventListener('change', refreshMessage);

  function openModal() {
    try { currentName = localStorage.getItem(LS_NAME) || ''; } catch { currentName = ''; }
    currentAssignment = findCurrentAssignment(data, currentName, event);

    if (currentAssignment) {
      contextEl.innerHTML = `<div><strong>${escapeHtml(currentName)}</strong></div>
        <div>${escapeHtml(currentAssignment.station)}</div>
        <div>${fmt12(currentAssignment.start_time)}–${fmt12(currentAssignment.end_time)}</div>`;

      windowRow.hidden = false;
      targetRow.hidden = false;

      steps = timeRangeSteps(currentAssignment.start_time, currentAssignment.end_time);
      startSel.innerHTML = steps.slice(0, -1).map((t) => `<option value="${t}">${fmt12(t)}</option>`).join('');
      startSel.value = currentAssignment.start_time;
      populateEndOptions();
      populateTargetOptions();
    } else {
      windowRow.hidden = true;
      targetRow.hidden = true;
      contextEl.innerHTML = currentName
        ? `<div><strong>${escapeHtml(currentName)}</strong> — no active slot right now</div>`
        : '<div class="hint">Select your name in My Schedule first</div>';
    }

    refreshMessage();
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
