// Builds an RFC 5545 iCalendar (.ics) feed of one person's shifts, for the
// "add to calendar" download and the webcal subscription. Pure + no deps so it
// is unit-testable. The calendar is a convenience, not a source of truth: the
// live app can change shifts (swaps/partial covers) faster than any calendar
// refreshes, so each event links back to the app and UIDs are deterministic
// (event+name+day+start+station, NOT the DB row id, which partial covers reassign).

// Minutes `tz` is ahead of UTC at the given instant (DST-aware via Intl).
function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

function fmtStamp(utc) {
  const p = (n) => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}${p(utc.getUTCMonth() + 1)}${p(utc.getUTCDate())}`
    + `T${p(utc.getUTCHours())}${p(utc.getUTCMinutes())}${p(utc.getUTCSeconds())}Z`;
}

// A wall-clock time in `tz` ('YYYY-MM-DD','HH:MM') -> UTC iCal stamp 'YYYYMMDDTHHMMSSZ'.
// Correct the offset twice so times within a DST-transition hour resolve to the
// true instant (the first guess reads the wall time as if UTC).
export function toUTCStamp(dateStr, timeStr, tz) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, mi, 0);
  let utc = guess - tzOffsetMinutes(tz, new Date(guess)) * 60000;
  utc = guess - tzOffsetMinutes(tz, new Date(utc)) * 60000;
  return fmtStamp(new Date(utc));
}

// RFC 5545 text escaping (backslash first; then all line breaks incl. a lone CR;
// then strip remaining control chars so a crafted value can't inject lines).
function esc(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// RFC 5545 §3.1 line folding at 75 octets (UTF-8 aware; continuation lines start
// with a space, which counts toward the 75). Keeps strict parsers (some Outlook /
// Java) happy on long SUMMARY/DESCRIPTION/CALNAME lines.
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let bytes = 0;
  let first = true;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = first ? 75 : 74;
    if (bytes + b > limit) { out.push(cur); cur = ch; bytes = b; first = false; } else { cur += ch; bytes += b; }
  }
  out.push(cur);
  return out.join('\r\n ');
}

// Add N days to a 'YYYY-MM-DD' string, returning the same format.
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// shifts: [{ date, start_time, end_time, station, is_floater }] (already this person's).
export function buildICS({ eventId, eventName, personName, tz, shifts, now = new Date() }) {
  const stamp = fmtStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//IBC Staff Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    `X-WR-CALNAME:${esc(`${eventName} — ${personName}`)}`,
    `X-WR-TIMEZONE:${esc(tz)}`,
  ];
  for (const s of shifts) {
    if (!s.date || !s.start_time || !s.end_time) continue; // can't place an incomplete row
    const station = s.station || 'Shift';
    const dtStart = toUTCStamp(s.date, s.start_time, tz);
    // Overnight / midnight-end shifts: if end is not after start, it rolls to the next day.
    let dtEnd = toUTCStamp(s.date, s.end_time, tz);
    if (dtEnd <= dtStart) dtEnd = toUTCStamp(addDays(s.date, 1), s.end_time, tz);
    const summary = `IBC: ${station}${s.is_floater ? ' (Floater)' : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${slug(eventId)}-${slug(personName) || 'staff'}-${s.date}-${s.start_time.replace(':', '')}-${slug(station) || 'shift'}@ibc.adobeschedule.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${esc(summary)}`,
      'LOCATION:RAI Amsterdam',
      'DESCRIPTION:Live schedule: https://ibc.adobeschedule.com — check the app for changes.',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Shift starting soon',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
