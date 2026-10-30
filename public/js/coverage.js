import {
  toMins, fmt12, escapeHtml, timeRangeSteps,
} from './time-utils.js';
import { getFreeFloaters, overlappingShifts } from './schedule.js';
import { resolveEventId } from './event-config.js';

const eventId = resolveEventId();

// Look up a person's phone from the public directory (cached) to build the
// requester's one-tap "text them" nudge.
let directoryCache = null;
async function phoneFor(name) {
  if (!directoryCache) {
    try { directoryCache = await (await fetch(`/api/directory/${eventId}`)).json(); } catch { directoryCache = []; }
  }
  const c = (directoryCache || []).find((x) => x.name && x.name.trim().toLowerCase() === name.trim().toLowerCase());
  return c && c.phone ? c.phone : null;
}

// "asking <target>" for a directed request; falls back to today's open
// broadcast wording when no specific person is chosen.
function buildShiftChangeMessage(name, assignment, windowStart, windowEnd, target) {
  const time = `${fmt12(windowStart)}–${fmt12(windowEnd)}`;
  if (target) {
    return `SHIFT CHANGE: ${name} needs ${assignment.station} covered ${time} — asking ${target}.`;
  }
  return `COVERAGE NEEDED: ${name} at ${assignment.station} — ${time}. Can anyone cover?`;
}

const OPEN_ASK = 'open-ask';

// Builds the (initially hidden) Shift Change Request modal and returns
// { open(slot, requesterName) } -- called by whoever's showing the specific
// shift being requested (a card in My Schedule), so the modal is always
// pre-filled from that exact slot rather than guessing from the real clock.
export function initShiftChangeModal(data, event) {
  const modal = document.createElement('div');
  modal.className = 'coverage-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="coverage-backdrop"></div>
    <div class="coverage-sheet">
      <sp-dialog size="m" no-divider>
      <h2 slot="heading" id="coverage-title">Request shift change</h2>
      <div class="coverage-context" id="cov-context"></div>
      <div class="cov-window-row" id="cov-window-row">
        <div class="cov-field">
          <sp-field-label for="cov-start">From</sp-field-label>
          <sp-picker id="cov-start" label="From"></sp-picker>
        </div>
        <div class="cov-field">
          <sp-field-label for="cov-end">To</sp-field-label>
          <sp-picker id="cov-end" label="To"></sp-picker>
        </div>
      </div>
      <div class="cov-field" id="cov-target-row">
        <sp-field-label for="cov-target">Ask</sp-field-label>
        <sp-picker id="cov-target" label="Ask"></sp-picker>
      </div>
      <div class="cov-field">
        <sp-field-label for="cov-msg">Message</sp-field-label>
        <sp-textfield id="cov-msg" multiline rows="2" label="Message"></sp-textfield>
      </div>
      <p class="coverage-status" id="cov-status"></p>
      <sp-button id="cov-copy" size="s" variant="secondary" treatment="outline">Copy message</sp-button>
      <sp-button slot="button" id="cov-cancel" variant="secondary" treatment="outline">Cancel</sp-button>
      <sp-button slot="button" id="cov-send" variant="primary">Submit request</sp-button>
      </sp-dialog>
    </div>`;
  document.querySelector('sp-theme').append(modal);

  const contextEl = modal.querySelector('#cov-context');
  const startSel = modal.querySelector('#cov-start');
  const endSel = modal.querySelector('#cov-end');
  const targetSel = modal.querySelector('#cov-target');
  const msgEl = modal.querySelector('#cov-msg');
  const sendBtn = modal.querySelector('#cov-send');
  const copyBtn = modal.querySelector('#cov-copy');
  const statusEl = modal.querySelector('#cov-status');
  const backdrop = modal.querySelector('.coverage-backdrop');

  let requesterName = '';
  let assignment = null;
  let steps = [];

  // sp-menu-item treats an empty value as its text, so open asks use a sentinel.
  const targetName = () => (targetSel.value === OPEN_ASK ? '' : targetSel.value);

  function refreshMessage() {
    msgEl.value = buildShiftChangeMessage(
      requesterName,
      assignment,
      startSel.value,
      endSel.value,
      targetName(),
    );
  }

  // Candidates are ALL staff, not just floaters (per field feedback — people
  // on-site for meetings can cover too). Floaters on backup this slot are grouped
  // first; everyone else follows, flagged if they already have an overlapping
  // shift.
  function populateTargetOptions() {
    const prev = targetSel.value; // keep the chosen coverer across repopulate
    const start = startSel.value;
    const end = endSel.value;
    const floaterNames = new Set(
      getFreeFloaters(data, assignment.day, toMins(start))
        .map((r) => r.staff_name).filter(Boolean).filter((n) => n !== requesterName),
    );
    const allNames = [...new Set(data.map((r) => r.staff_name).filter(Boolean))].sort();
    const others = allNames.filter((n) => !floaterNames.has(n) && n !== requesterName);
    const opt = (n, booked) => `<sp-menu-item value="${escapeHtml(n)}">${escapeHtml(n)}${booked ? ' — already booked' : ''}</sp-menu-item>`;

    const floaterOpts = [...floaterNames].sort().map((n) => opt(n, false)).join('');
    const otherOpts = others
      .map((n) => opt(n, overlappingShifts(data, n, assignment.day, start, end).length > 0))
      .join('');

    targetSel.innerHTML = `<sp-menu-item value="${OPEN_ASK}">Anyone / open ask</sp-menu-item>`
      + (floaterOpts ? `<sp-menu-group><span slot="header">On backup now</span>${floaterOpts}</sp-menu-group>` : '')
      + (otherOpts ? `<sp-menu-group><span slot="header">Everyone else</span>${otherOpts}</sp-menu-group>` : '');
    targetSel.value = prev && [...targetSel.querySelectorAll('sp-menu-item')].some((o) => o.value === prev) ? prev : OPEN_ASK;
  }

  function populateEndOptions() {
    const options = steps.filter((t) => toMins(t) > toMins(startSel.value));
    endSel.innerHTML = options.map((t) => `<sp-menu-item value="${t}">${fmt12(t)}</sp-menu-item>`).join('');
    endSel.value = assignment.end_time;
  }

  function onStartChange() {
    populateEndOptions();
    populateTargetOptions();
    refreshMessage();
  }

  startSel.addEventListener('change', onStartChange);
  endSel.addEventListener('change', () => { populateTargetOptions(); refreshMessage(); });
  targetSel.addEventListener('change', refreshMessage);

  let opener = null;
  const pageBehind = document.getElementById('app');

  function closeModal() {
    modal.hidden = true;
    pageBehind.inert = false;
    opener?.focus();
  }

  modal.querySelector('#cov-cancel').addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  async function submitRequest() {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Submitting…';
    statusEl.textContent = '';
    try {
      const resp = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          requesterName,
          shiftId: assignment.id,
          targetName: targetName() || null,
          message: msgEl.value,
          requestedStart: startSel.value,
          requestedEnd: endSel.value,
        }),
      });
      const data = await resp.json();
      if (resp.ok) {
        statusEl.dataset.kind = 'ok';
        const target = targetName();
        sendBtn.textContent = 'Submitted';
        if (target) {
          // Directed ask: it waits for that person to accept. Offer a one-tap
          // text so the requester can nudge them to open the app.
          statusEl.textContent = `✓ Sent to ${target} to accept. `;
          const phone = await phoneFor(target);
          if (phone) {
            const where = (event.branding && event.branding.shortName) || event.name || 'the event';
            const body = `Can you cover my ${assignment.station} ${fmt12(startSel.value)}–${fmt12(endSel.value)} on ${assignment.day} at ${where}? Open the staff app → My Schedule to accept.`;
            const a = document.createElement('sp-button');
            a.className = 'coverage-sms';
            a.setAttribute('size', 's');
            a.setAttribute('variant', 'secondary');
            a.href = `sms:${phone.replace(/[^\d+]/g, '')}?body=${encodeURIComponent(body)}`;
            a.textContent = `Text ${target}`;
            statusEl.append(a);
          }
        } else {
          statusEl.textContent = '✓ Request submitted — an admin will confirm coverage.';
          setTimeout(closeModal, 1600);
        }
      } else {
        statusEl.dataset.kind = 'err';
        statusEl.textContent = data.error || 'Could not submit — try again.';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Submit request';
      }
    } catch {
      statusEl.dataset.kind = 'err';
      statusEl.textContent = 'Network error — try again.';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Submit request';
    }
  }

  sendBtn.addEventListener('click', submitRequest);

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(msgEl.value);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy message'; }, 2000);
    } catch {
      msgEl.focusElement?.select();
    }
  });

  document.addEventListener('keydown', (e) => {
    // With a picker open, Esc only dismisses that picker's list.
    if (e.key === 'Escape' && !modal.hidden && !modal.querySelector('sp-picker[open]')) closeModal();
  });

  function open(slot, name) {
    assignment = slot;
    requesterName = name;

    contextEl.innerHTML = `<div>${escapeHtml(assignment.station)} · ${escapeHtml(assignment.day)}</div>
      <div>${fmt12(assignment.start_time)}–${fmt12(assignment.end_time)}</div>`;

    targetSel.value = OPEN_ASK; // never carry the last request's coworker into a new one
    steps = timeRangeSteps(assignment.start_time, assignment.end_time);
    startSel.innerHTML = steps.slice(0, -1).map((t) => `<sp-menu-item value="${t}">${fmt12(t)}</sp-menu-item>`).join('');
    startSel.value = assignment.start_time;
    populateEndOptions();
    populateTargetOptions();
    refreshMessage();

    sendBtn.disabled = false;
    sendBtn.textContent = 'Submit request';
    statusEl.textContent = '';
    statusEl.dataset.kind = '';

    opener = document.activeElement;
    modal.hidden = false;
    pageBehind.inert = true;
    startSel.focus(); // not the message box: that would pop the phone keyboard over the form
  }

  return { open };
}
