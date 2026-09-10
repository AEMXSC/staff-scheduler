// Focused prod E2E for the PARTIAL-cover split fix. Files an open ask for a
// sub-window of a shift, approves it, and asserts the shift split into:
//   coverer  @ [w0,w1]   (the covered window, on the original row)
//   owner    @ [S,w0]    (leading remainder, new row)
//   owner    @ [w1,E]    (trailing remainder, new row)
// Then fully recombines. The finally block is the safety net: it restores the
// original row and DELETES any row whose id did not exist before the test, so a
// mid-run failure can never leave orphan remainder rows on the live schedule.
//
//   BASE=https://ibc.adobeschedule.com node scripts/split-e2e.mjs

const BASE = process.env.BASE || 'https://ibc.adobeschedule.com';
const PASSPHRASE = process.env.PASSPHRASE || 'test';
const EVENT = 'ibc-2026';

let pass = 0; let fail = 0; const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); } else { fail += 1; failures.push(name); console.log(`  ✗ ${name}  — ${detail || 'FAILED'}`); }
};
const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': 'split-e2e' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}
const sched = async () => (await api(`/api/schedule/${EVENT}`)).data || [];
const rowById = (rows, id) => rows.find((r) => r.id === id);

async function main() {
  console.log(`Partial-cover split E2E against ${BASE}\n`);
  const token = (await api('/api/admin/auth', { method: 'POST', body: { passphrase: PASSPHRASE } })).data?.token;
  check('admin login', !!token);
  if (!token) process.exit(1);

  const before = await sched();
  const beforeIds = new Set(before.map((r) => r.id));
  // A non-floater shift with >= 90 min span so a clean middle window exists.
  const shift = before.find((r) => !r.is_floater && r.id && toMin(r.end_time) - toMin(r.start_time) >= 90);
  const owner = shift.staff_name;
  const coverer = before.find((r) => r.staff_name && r.staff_name !== owner).staff_name;
  const S = shift.start_time; const E = shift.end_time;
  const w0 = fromMin(toMin(S) + 30); const w1 = fromMin(toMin(S) + 60); // middle third
  check('picked a test shift', true, `${shift.station} ${shift.day} ${S}-${E} (owner ${owner}); cover ${w0}-${w1} by ${coverer}`);

  try {
    // File an OPEN ask for just the middle window, then approve with the coverer.
    const req = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: owner, shiftId: shift.id, targetName: null, requestedStart: w0, requestedEnd: w1, message: 'split-e2e: partial cover' } });
    check('partial request accepted', req.status === 200 && req.data?.ok, `status ${req.status}`);
    const ap = await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: req.data.id, action: 'approve', covererName: coverer } });
    check('admin approves partial cover', ap.status === 200, ap.data?.message || `status ${ap.status}`);

    const after = await sched();
    const covered = rowById(after, shift.id);
    check('covered row now owned by coverer', covered && covered.staff_name === coverer, covered && `${covered.staff_name}`);
    check('covered row trimmed to requested window', covered && covered.start_time === w0 && covered.end_time === w1, covered && `${covered.start_time}-${covered.end_time}`);

    const newRows = after.filter((r) => !beforeIds.has(r.id) && r.station === shift.station && r.day === shift.day);
    const lead = newRows.find((r) => r.start_time === S && r.end_time === w0);
    const trail = newRows.find((r) => r.start_time === w1 && r.end_time === E);
    check('exactly 2 remainder rows created', newRows.length === 2, `${newRows.length} new`);
    check('leading remainder kept by owner', lead && lead.staff_name === owner, lead && `${lead.staff_name} ${lead.start_time}-${lead.end_time}`);
    check('trailing remainder kept by owner', trail && trail.staff_name === owner, trail && `${trail.staff_name} ${trail.start_time}-${trail.end_time}`);
    check('coverer is NOT assigned the whole shift', covered.start_time !== S || covered.end_time !== E, 'window only');
  } finally {
    // Bulletproof restore: reset the original row, delete any row created by the test.
    const now = await sched();
    const orig = rowById(now, shift.id);
    if (orig && (orig.staff_name !== owner || orig.start_time !== S || orig.end_time !== E)) {
      await api('/api/admin/confirm', { method: 'POST', token, body: { pendingAction: { type: 'edit_shift_time', ids: [shift.id], expect: [{ staff_name: orig.staff_name, station: orig.station, start_time: orig.start_time, end_time: orig.end_time }], new_start_time: S, new_end_time: E } } });
      const mid = rowById(await sched(), shift.id);
      if (mid && mid.staff_name !== owner) {
        await api('/api/admin/confirm', { method: 'POST', token, body: { pendingAction: { type: 'cover_shift', ids: [shift.id], expect: [{ staff_name: mid.staff_name, station: mid.station, start_time: S, end_time: E }], coverer: owner } } });
      }
    }
    const orphans = (await sched()).filter((r) => !beforeIds.has(r.id));
    for (const o of orphans) {
      await api('/api/admin/confirm', { method: 'POST', token, body: { pendingAction: { type: 'cancel_shift', ids: [o.id], expect: [{ staff_name: o.staff_name, station: o.station, start_time: o.start_time, end_time: o.end_time }] } } });
    }
    const restored = await sched();
    const fin = rowById(restored, shift.id);
    const sameCount = restored.length === before.length;
    const noOrphans = restored.every((r) => beforeIds.has(r.id));
    check('schedule fully restored', sameCount && noOrphans && fin && fin.staff_name === owner && fin.start_time === S && fin.end_time === E,
      `${restored.length} rows (was ${before.length}); shift owner ${fin && fin.staff_name} ${fin && fin.start_time}-${fin && fin.end_time}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', failures.join(', '));
  process.exit(fail ? 1 : 0);
}
main();
