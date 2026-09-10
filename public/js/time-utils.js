// Shared time/CSV helpers. Timezone-agnostic: every function takes an IANA
// tz string so the same code serves any event (Summit was PDT-only; this
// generalizes it).

export function getSimtime() {
  const p = new URLSearchParams(window.location.search).get('simtime');
  if (!p) return null;
  const d = new Date(p);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getZonedNow(tz, date) {
  const d = date || getSimtime() || new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    totalMins: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
  };
}

export function toMins(hhmm) {
  const [h, m] = (hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Half-hour boundary times between start and end, inclusive of both ends --
// used to populate the shift-change request's "From"/"To" dropdowns.
export function timeRangeSteps(start, end, stepMins = 30) {
  const endMins = toMins(end);
  const steps = [];
  for (let mins = toMins(start); mins < endMins; mins += stepMins) {
    steps.push(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
  }
  steps.push(end);
  return steps;
}

export function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

// Live status line for the header bar ("Starts in 2 days" / "LIVE — Day 2
// of 4 (Saturday)" / "Event complete — great work team!"), computed from the
// event's own day list so it flips automatically as the event runs.
export function getEventStatus(days, tz) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const { dateStr } = getZonedNow(tz);
  const first = sorted[0].date;
  const last = sorted[sorted.length - 1].date;

  if (dateStr < first) {
    const daysOut = Math.round(
      (new Date(`${first}T00:00:00`) - new Date(`${dateStr}T00:00:00`)) / 86400000,
    );
    return { text: daysOut <= 1 ? 'Starts tomorrow' : `Starts in ${daysOut} days`, kind: 'upcoming' };
  }
  if (dateStr > last) {
    return { text: 'Event complete — great work team!', kind: 'complete' };
  }
  const todayIdx = sorted.findIndex((d) => d.date === dateStr);
  return { text: `LIVE — Day ${todayIdx + 1} of ${sorted.length} (${sorted[todayIdx].day})`, kind: 'live' };
}

// "Sept 11–14" from a day list -- assumes a single-month span (true for
// every event so far; revisit if one straddles a month boundary).
export function formatDateRange(days) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const start = new Date(`${sorted[0].date}T00:00:00`);
  const end = new Date(`${sorted[sorted.length - 1].date}T00:00:00`);
  const month = start.toLocaleDateString('en-US', { month: 'short' });
  return start.getDate() === end.getDate() ? `${month} ${start.getDate()}` : `${month} ${start.getDate()}–${end.getDate()}`;
}

export async function fetchScheduleData(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Data ultimately comes from a spreadsheet edited by non-engineers -- never
// trust staff_name/station text going into innerHTML, in text or attribute position.
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}
