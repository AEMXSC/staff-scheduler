// Proves the exact drift-guarded /api/admin/confirm payloads that repair the two
// mis-assigned IBC shifts, for BOTH options each. For every path it applies the
// payload(s), asserts the resulting rows, then fully restores the broken state
// (reset the target row + delete any rows the split created) so prod is left
// exactly as found. These verified payloads get embedded in the cloud routine.
//
//   BASE=https://ibc.adobeschedule.com node scripts/repair-e2e.mjs

const BASE = process.env.BASE || 'https://ibc.adobeschedule.com';
const PASS = process.env.PASSPHRASE || 'test';

let pass = 0; let fail = 0; const failures = [];
const check = (n, ok, d = '') => { if (ok) { pass += 1; console.log(`  ✓ ${n}${d ? '  — ' + d : ''}`); } else { fail += 1; failures.push(n); console.log(`  ✗ ${n}  — ${d || 'FAILED'}`); } };

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': 'repair-e2e' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
const sched = async () => (await api('/api/schedule/ibc-2026')).data || [];
const rowById = (rows, id) => rows.find((r) => r.id === id);
let token;
const confirm = (pendingAction) => api('/api/admin/confirm', { method: 'POST', token, body: { pendingAction } });

// --- payloads under test (what will be embedded in the routine) ---
const BEN = { id: 774, coverer: 'Karl Soule', requester: 'Ben Smith', station: 'Premiere Floater', S: '14:30', E: '18:15', wS: '15:00', wE: '16:00' };
const ZACK = { id: 841, coverer: 'Sebastien Perier', requester: 'Zack Einhorn', station: 'After Effects', S: '13:30', E: '18:15', wS: '14:00', wE: '15:00' };

const revertToRequester = (x) => confirm({ type: 'cover_shift', ids: [x.id], expect: [{ staff_name: x.coverer, station: x.station, start_time: x.S, end_time: x.E }], coverer: x.requester });
const splitToCoverer = (x) => confirm({ type: 'cover_shift', ids: [x.id], expect: [{ staff_name: x.requester, station: x.station, start_time: x.S, end_time: x.E }], coverer: x.coverer, window: { start: x.wS, end: x.wE } });

async function testOption(x, label, option) {
  const before = await sched();
  const beforeIds = new Set(before.map((r) => r.id));
  check(`[${label} ${option}] starts broken (row ${x.id} = ${x.coverer} full)`, (() => { const r = rowById(before, x.id); return r && r.staff_name === x.coverer && r.start_time === x.S && r.end_time === x.E; })());

  if (option === 'A') {
    const r = await revertToRequester(x);
    check(`[${label} A] confirm ok`, r.status === 200, r.data?.message || `status ${r.status}`);
    const after = await sched();
    const row = rowById(after, x.id);
    check(`[${label} A] row now full-shift to ${x.requester}`, row && row.staff_name === x.requester && row.start_time === x.S && row.end_time === x.E, row && `${row.staff_name} ${row.start_time}-${row.end_time}`);
    check(`[${label} A] no new rows`, after.length === before.length, `${after.length} vs ${before.length}`);
  } else {
    const r1 = await revertToRequester(x);
    check(`[${label} B] step1 revert ok`, r1.status === 200, r1.data?.message || `status ${r1.status}`);
    const r2 = await splitToCoverer(x);
    check(`[${label} B] step2 split ok`, r2.status === 200, r2.data?.message || `status ${r2.status}`);
    const after = await sched();
    const covered = rowById(after, x.id);
    check(`[${label} B] covered window to ${x.coverer}`, covered && covered.staff_name === x.coverer && covered.start_time === x.wS && covered.end_time === x.wE, covered && `${covered.staff_name} ${covered.start_time}-${covered.end_time}`);
    const newRows = after.filter((rr) => !beforeIds.has(rr.id) && rr.station === x.station);
    const lead = newRows.find((rr) => rr.start_time === x.S && rr.end_time === x.wS);
    const trail = newRows.find((rr) => rr.start_time === x.wE && rr.end_time === x.E);
    check(`[${label} B] 2 remainder rows to ${x.requester}`, newRows.length === 2 && lead && trail && lead.staff_name === x.requester && trail.staff_name === x.requester, `${newRows.length} new`);
  }

  // --- restore to broken: delete any new rows, reset target row to coverer@full ---
  let now = await sched();
  for (const o of now.filter((rr) => !beforeIds.has(rr.id))) {
    await confirm({ type: 'cancel_shift', ids: [o.id], expect: [{ staff_name: o.staff_name, station: o.station, start_time: o.start_time, end_time: o.end_time }] });
  }
  now = await sched();
  const cur = rowById(now, x.id);
  if (cur && (cur.start_time !== x.S || cur.end_time !== x.E)) {
    await confirm({ type: 'edit_shift_time', ids: [x.id], expect: [{ staff_name: cur.staff_name, station: cur.station, start_time: cur.start_time, end_time: cur.end_time }], new_start_time: x.S, new_end_time: x.E });
  }
  const c2 = rowById(await sched(), x.id);
  if (c2 && c2.staff_name !== x.coverer) {
    await confirm({ type: 'cover_shift', ids: [x.id], expect: [{ staff_name: c2.staff_name, station: x.station, start_time: x.S, end_time: x.E }], coverer: x.coverer });
  }
  const restored = await sched();
  const fin = rowById(restored, x.id);
  check(`[${label} ${option}] restored to broken (row ${x.id} = ${x.coverer} full, ${before.length} rows)`,
    restored.length === before.length && fin && fin.staff_name === x.coverer && fin.start_time === x.S && fin.end_time === x.E,
    `${restored.length} rows; ${fin && fin.staff_name} ${fin && fin.start_time}-${fin && fin.end_time}`);
}

async function main() {
  console.log(`Repair-payload E2E against ${BASE}\n`);
  token = (await api('/api/admin/auth', { method: 'POST', body: { passphrase: PASS } })).data?.token;
  check('admin login', !!token);
  if (!token) process.exit(1);
  for (const [x, label] of [[BEN, 'BEN'], [ZACK, 'ZACK']]) {
    for (const opt of ['A', 'B']) {
      console.log(`\n── ${label} option ${opt} ──`);
      // eslint-disable-next-line no-await-in-loop
      await testOption(x, label, opt);
    }
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', failures.join(', '));
  process.exit(fail ? 1 : 0);
}
main();
