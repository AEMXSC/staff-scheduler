// Verifies a partial-window request's requested_start/end flows through to the
// staff-facing endpoints that back the "my requests" and "asked you to cover"
// cards — the display bug Lena hit (a 2:30-3:30 request showing as 2:30-6:15).
// Files a directed partial request, checks both endpoints return the window,
// then declines it (no schedule change). Full-shift default is checked too.
//
//   BASE=https://ibc.adobeschedule.com node scripts/window-display-test.mjs

const BASE = process.env.BASE || 'https://ibc.adobeschedule.com';
const PASS = process.env.PASSPHRASE || 'test';
const EVENT = 'ibc-2026';

let pass = 0; let fail = 0; const failures = [];
const check = (n, ok, d = '') => { if (ok) { pass += 1; console.log(`  ✓ ${n}${d ? '  — ' + d : ''}`); } else { fail += 1; failures.push(n); console.log(`  ✗ ${n}  — ${d || 'FAILED'}`); } };
const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': 'window-test' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}

async function main() {
  console.log(`Window-display test against ${BASE}\n`);
  const token = (await api('/api/admin/auth', { method: 'POST', body: { passphrase: PASS } })).data?.token;
  check('admin login', !!token);
  if (!token) process.exit(1);

  const sched = (await api(`/api/schedule/${EVENT}`)).data || [];
  const shift = sched.find((r) => !r.is_floater && r.id && toMin(r.end_time) - toMin(r.start_time) >= 90);
  const requester = shift.staff_name;
  const target = sched.find((r) => r.staff_name && r.staff_name !== requester).staff_name;
  const wStart = fromMin(toMin(shift.start_time) + 30);
  const wEnd = fromMin(toMin(shift.start_time) + 60);
  check('picked a test shift', true, `${shift.station} ${shift.day} ${shift.start_time}-${shift.end_time}; requesting ${wStart}-${wEnd}, asking ${target}`);

  let reqId;
  try {
    const r = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: requester, shiftId: shift.id, targetName: target, requestedStart: wStart, requestedEnd: wEnd, message: 'window-test' } });
    check('directed partial request created', r.status === 200 && r.data?.id, `status ${r.status}`);
    reqId = r.data.id;

    // "asked you to cover" card data
    const forT = await api(`/api/requests/for?eventId=${EVENT}&name=${encodeURIComponent(target)}`);
    const mineFor = (forT.data || []).find((x) => x.id === reqId);
    check('/for returns the request', !!mineFor);
    check('/for shows the REQUESTED window (not full shift)', mineFor && mineFor.requested_start === wStart && mineFor.requested_end === wEnd, mineFor && `${mineFor.requested_start}-${mineFor.requested_end} (shift ${mineFor.start_time}-${mineFor.end_time})`);

    // "my requests" card data
    const mine = await api(`/api/requests/mine?eventId=${EVENT}&name=${encodeURIComponent(requester)}`);
    const mineRow = (mine.data || []).find((x) => x.id === reqId);
    check('/mine returns the request', !!mineRow);
    check('/mine shows the REQUESTED window (not full shift)', mineRow && mineRow.requested_start === wStart && mineRow.requested_end === wEnd, mineRow && `${mineRow.requested_start}-${mineRow.requested_end} (shift ${mineRow.start_time}-${mineRow.end_time})`);

    // Full-shift request defaults window to the whole shift
    const r2 = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: requester, shiftId: shift.id, targetName: null, requestedStart: shift.start_time, requestedEnd: shift.end_time } });
    // (may be blocked as duplicate-open vs the directed one on same shift; only assert if created)
    if (r2.status === 200 && r2.data?.id) {
      const mine2 = await api(`/api/requests/mine?eventId=${EVENT}&name=${encodeURIComponent(requester)}`);
      const full = (mine2.data || []).find((x) => x.id === r2.data.id);
      check('full-shift request: window == full shift', full && full.requested_start === shift.start_time && full.requested_end === shift.end_time, full && `${full.requested_start}-${full.requested_end}`);
      await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: r2.data.id, action: 'decline' } });
    } else {
      console.log('  · (full-shift case skipped — open request blocked as duplicate on same shift, expected)');
    }
  } finally {
    // Cleanup: target declines the directed request -> no schedule change.
    if (reqId) await api('/api/requests/respond', { method: 'POST', body: { id: reqId, name: target, action: 'decline' } });
    const inbox = await api(`/api/admin/requests?eventId=${EVENT}`, { token });
    check('no test requests left pending', Array.isArray(inbox.data) && !inbox.data.some((x) => x.id === reqId), `${(inbox.data || []).length} pending`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', failures.join(', '));
  process.exit(fail ? 1 : 0);
}
main();
