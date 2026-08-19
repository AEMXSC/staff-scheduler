import {
  toMins, fmt12, escapeHtml, timeRangeSteps,
} from './time-utils.js';
import { getFreeFloaters } from './schedule.js';

// "asking <target>" for a directed request; falls back to today's open
// broadcast wording when no specific person is chosen.
function buildShiftChangeMessage(name, assignment, windowStart, windowEnd, target) {
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

// Builds the (initially hidden) Shift Change Request modal and returns
// { open(slot, requesterName) } -- called by whoever's showing the specific
// shift being requested (a card in My Schedule), so the modal is always
// pre-filled from that exact slot rather than guessing from the real clock.
export function initShiftChangeModal(data, event) {
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
      <div class="cov-window-row" id="cov-window-row">
        <div class="cov-field">
          <label for="cov-start">From</label>
          <select id="cov-start"></select>
        </div>
        <div class="cov-field">
          <label for="cov-end">To</label>
          <select id="cov-end"></select>
        </div>
      </div>
      <div class="cov-field" id="cov-target-row">
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
  const startSel = modal.querySelector('#cov-start');
  const endSel = modal.querySelector('#cov-end');
  const targetSel = modal.querySelector('#cov-target');
  const msgEl = modal.querySelector('#cov-msg');
  const sendBtn = modal.querySelector('#cov-send');
  const copyBtn = modal.querySelector('#cov-copy');
  const closeBtn = modal.querySelector('.coverage-close');
  const backdrop = modal.querySelector('.coverage-backdrop');

  let requesterName = '';
  let assignment = null;
  let steps = [];

  function refreshMessage() {
    msgEl.value = buildShiftChangeMessage(
      requesterName,
      assignment,
      startSel.value,
      endSel.value,
      targetSel.value,
    );
  }

  function populateTargetOptions() {
    const names = [...new Set(
      getFreeFloaters(data, assignment.day, toMins(startSel.value)).map((r) => r.staff_name),
    )];
    targetSel.innerHTML = ['<option value="">Anyone / open ask</option>']
      .concat(names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`))
      .join('');
  }

  function populateEndOptions() {
    const options = steps.filter((t) => toMins(t) > toMins(startSel.value));
    endSel.innerHTML = options.map((t) => `<option value="${t}">${fmt12(t)}</option>`).join('');
    endSel.value = assignment.end_time;
  }

  function onStartChange() {
    populateEndOptions();
    populateTargetOptions();
    refreshMessage();
  }

  startSel.addEventListener('change', onStartChange);
  endSel.addEventListener('change', refreshMessage);
  targetSel.addEventListener('change', refreshMessage);

  function closeModal() {
    modal.hidden = true;
  }

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

  function open(slot, name) {
    assignment = slot;
    requesterName = name;

    contextEl.innerHTML = `<div><strong>${escapeHtml(requesterName)}</strong></div>
      <div>${escapeHtml(assignment.station)} · ${escapeHtml(assignment.day)}</div>
      <div>${fmt12(assignment.start_time)}–${fmt12(assignment.end_time)}</div>`;

    steps = timeRangeSteps(assignment.start_time, assignment.end_time);
    startSel.innerHTML = steps.slice(0, -1).map((t) => `<option value="${t}">${fmt12(t)}</option>`).join('');
    startSel.value = assignment.start_time;
    populateEndOptions();
    populateTargetOptions();
    refreshMessage();

    modal.hidden = false;
    msgEl.focus();
  }

  return { open };
}
