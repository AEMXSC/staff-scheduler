// Unit test for the .ics builder (pure, no network/DB). Run: node scripts/ics-test.mjs
import { buildICS, toUTCStamp } from '../src/ics.js';

let pass = 0; let fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}  — ${d}`); } };

// --- toUTCStamp: Amsterdam is CEST (UTC+2) in September ---
check('CEST 14:30 -> 12:30 UTC', toUTCStamp('2026-09-11', '14:30', 'Europe/Amsterdam') === '20260911T123000Z', toUTCStamp('2026-09-11', '14:30', 'Europe/Amsterdam'));
check('CEST 09:15 -> 07:15 UTC', toUTCStamp('2026-09-13', '09:15', 'Europe/Amsterdam') === '20260913T071500Z', toUTCStamp('2026-09-13', '09:15', 'Europe/Amsterdam'));
// A winter date would be CET (UTC+1) — proves DST-awareness, not a hardcoded +2
check('CET (winter) 14:30 -> 13:30 UTC', toUTCStamp('2026-01-15', '14:30', 'Europe/Amsterdam') === '20260115T133000Z', toUTCStamp('2026-01-15', '14:30', 'Europe/Amsterdam'));
check('UTC tz passthrough', toUTCStamp('2026-09-11', '14:30', 'UTC') === '20260911T143000Z', toUTCStamp('2026-09-11', '14:30', 'UTC'));

// --- buildICS ---
const shifts = [
  { date: '2026-09-11', start_time: '14:30', end_time: '15:30', station: 'Premiere (COLOR)', is_floater: false },
  { date: '2026-09-12', start_time: '09:15', end_time: '13:30', station: 'Premiere Floater', is_floater: true },
  { date: null, start_time: '10:00', end_time: '11:00', station: 'Bad Row', is_floater: false }, // must be skipped
];
const ics = buildICS({ eventId: 'ibc-2026', eventName: 'IBC 2026', personName: "Aaron O'Burns, Jr", tz: 'Europe/Amsterdam', shifts, now: new Date('2026-09-10T12:00:00Z') });

check('wraps in VCALENDAR', ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR'));
check('CRLF line endings', ics.includes('\r\n') && !/[^\r]\n/.test(ics));
check('two VEVENTs (null-date row skipped)', (ics.match(/BEGIN:VEVENT/g) || []).length === 2);
check('DTSTART in UTC from CEST', ics.includes('DTSTART:20260911T123000Z'));
check('DTEND in UTC', ics.includes('DTEND:20260911T133000Z'));
check('floater flagged in SUMMARY', ics.includes('SUMMARY:IBC: Premiere Floater (Floater)'));
check('15-min VALARM present', ics.includes('BEGIN:VALARM') && ics.includes('TRIGGER:-PT15M'));
// Unfold (RFC 5545 §3.1) before matching — long lines like this UID are folded.
const unfold = (s) => s.replace(/\r\n /g, '');
check('deterministic UID from name+date+start+station', unfold(ics).includes('UID:ibc-2026-aaron-o-burns-jr-2026-09-11-1430-premiere-color@ibc.adobeschedule.com'));
check('links back to live app', ics.includes('ibc.adobeschedule.com'));
check('text escaping (comma in name)', ics.includes('X-WR-CALNAME:IBC 2026 — Aaron O\'Burns\\, Jr'));

// --- hardening fixes (from code review) ---
// M1: a lone CR in the name must be escaped, not injected as a new line
const crIcs = buildICS({ eventId: 'ibc-2026', eventName: 'IBC', personName: 'x\rSUMMARY:evil', tz: 'UTC', shifts: [], now: new Date('2026-09-10T12:00:00Z') });
check('M1 lone CR escaped (no injected line)', !crIcs.includes('\rSUMMARY:evil') && crIcs.includes('X-WR-CALNAME:IBC — x\\nSUMMARY:evil'));

// M2: rows missing start/end are skipped; null station falls back to a label
const edge = buildICS({ eventId: 'e', eventName: 'E', personName: 'P', tz: 'UTC', now: new Date('2026-09-10T12:00:00Z'), shifts: [
  { date: '2026-09-11', start_time: null, end_time: '12:00', station: 'A', is_floater: false },
  { date: '2026-09-11', start_time: '10:00', end_time: null, station: 'B', is_floater: false },
  { date: '2026-09-11', start_time: '10:00', end_time: '11:00', station: null, is_floater: false },
] });
check('M2 incomplete rows skipped (1 VEVENT)', (edge.match(/BEGIN:VEVENT/g) || []).length === 1);
check('M2 null station -> fallback label', edge.includes('SUMMARY:IBC: Shift'));

// M3: overnight (end <= start) rolls DTEND to the next day
const overnight = buildICS({ eventId: 'e', eventName: 'E', personName: 'P', tz: 'UTC', now: new Date('2026-09-10T12:00:00Z'), shifts: [
  { date: '2026-09-11', start_time: '22:00', end_time: '02:00', station: 'Night', is_floater: false },
] });
check('M3 overnight DTEND next day', overnight.includes('DTSTART:20260911T220000Z') && overnight.includes('DTEND:20260912T020000Z'));

// M4: same date+start but different station -> distinct UIDs (no silent collision)
const dup = buildICS({ eventId: 'e', eventName: 'E', personName: 'P', tz: 'UTC', now: new Date('2026-09-10T12:00:00Z'), shifts: [
  { date: '2026-09-11', start_time: '10:00', end_time: '11:00', station: 'Alpha', is_floater: false },
  { date: '2026-09-11', start_time: '10:00', end_time: '11:00', station: 'Beta', is_floater: true },
] });
const uids = dup.match(/UID:[^\r\n]+/g) || [];
check('M4 same-start shifts get distinct UIDs', uids.length === 2 && uids[0] !== uids[1]);

// L2: a line over 75 octets is folded (continuation starts with a space)
const folded = buildICS({ eventId: 'e', eventName: 'E', personName: 'P', tz: 'UTC', now: new Date('2026-09-10T12:00:00Z'), shifts: [
  { date: '2026-09-11', start_time: '10:00', end_time: '11:00', station: 'A'.repeat(90), is_floater: false },
] });
check('L2 long SUMMARY is folded', /\r\n /.test(folded));

// L3: DST edges — Amsterdam is CET (UTC+1) after the Oct fall-back, CEST (UTC+2) after the Mar spring-forward
check('L3 DST fall-back 14:30 -> 13:30 UTC', toUTCStamp('2026-10-26', '14:30', 'Europe/Amsterdam') === '20261026T133000Z', toUTCStamp('2026-10-26', '14:30', 'Europe/Amsterdam'));
check('L3 DST spring-forward 14:30 -> 12:30 UTC', toUTCStamp('2026-03-30', '14:30', 'Europe/Amsterdam') === '20260330T123000Z', toUTCStamp('2026-03-30', '14:30', 'Europe/Amsterdam'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
