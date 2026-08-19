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
