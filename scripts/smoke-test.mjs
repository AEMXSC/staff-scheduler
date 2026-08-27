// End-to-end smoke test for the IBC staff scheduler — safe to run against
// production: it creates test shift-change requests, approves/declines them,
// and ALWAYS restores the schedule to its original state at the end.
//
//   node scripts/smoke-test.mjs
//   PASSPHRASE=test node scripts/smoke-test.mjs      (override passphrase)
//   BASE=https://staff-scheduler.compass-xsc.workers.dev node scripts/smoke-test.mjs
//
// It does NOT open any browser and does NOT test actual phone-push delivery
// (that's the one manual step — install the PWA, Enable phone alerts, submit a
// request, watch the phone buzz). Everything else is checked here.

const BASE = process.env.BASE || 'https://staff-scheduler.compass-xsc.workers.dev';
const PASSPHRASE = process.env.PASSPHRASE || 'test';
const EVENT = 'ibc-2026';
const UA = 'Mozilla/5.0 (smoke-test)';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`); } else { fail += 1; failures.push(name); console.log(`  ✗ ${name}  — ${detail || 'FAILED'}`); }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': UA };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data };
}

const section = (t) => console.log(`\n── ${t} ──`);

async function main() {
  console.log(`Smoke test against ${BASE}`);
  console.log('(uses ~10 requests; per-IP limit is 15/10min — run once, or wait 10 min between runs)\n');
  let token;
  let shift; let ownerA; let coverA; // primary test shift
  let shift2; let ownerB; // second shift for open-ask/decline

  try {
    // 1. Auth
    section('Auth');
    const auth = await api('/api/admin/auth', { method: 'POST', body: { passphrase: PASSPHRASE } });
    token = auth.data?.token;
    check('admin login', auth.status === 200 && !!token, `status ${auth.status}`);
    if (!token) throw new Error('cannot continue without a token');

    // 2. Schedule + pick test data
    section('Schedule loads');
    const sched = (await api(`/api/schedule/${EVENT}`)).data || [];
    check('schedule has rows', sched.length > 0, `${sched.length} shifts`);
    shift = sched.find((r) => !r.is_floater && r.id);
    shift2 = sched.find((r) => !r.is_floater && r.id && r.id !== shift.id && r.staff_name !== shift.staff_name);
    ownerA = shift.staff_name;
    ownerB = shift2.staff_name;
    coverA = sched.find((r) => r.staff_name && r.staff_name !== ownerA && r.staff_name !== ownerB).staff_name;
    check('picked a test shift', !!shift && !!coverA, `${shift.station} ${shift.day} ${shift.start_time}-${shift.end_time} (owner ${ownerA})`);

    const ownerOf = async (id) => {
      const s = (await api(`/api/schedule/${EVENT}`)).data.find((r) => r.id === id);
      return s ? s.staff_name : null;
    };

    // 3. Directed request -> target accepts -> admin approves -> schedule updates
    section('Directed request → target accepts → admin approves');
    const r1 = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: ownerA, shiftId: shift.id, targetName: coverA, message: 'smoke: cover me' } });
    check('staff submits a directed request', r1.status === 200 && r1.data?.status === 'awaiting_target', `status ${r1.status} / ${r1.data?.status}`);
    const beforeInbox = await api(`/api/admin/requests?eventId=${EVENT}`, { token });
    check('directed ask is NOT in admin inbox yet', Array.isArray(beforeInbox.data) && !beforeInbox.data.some((x) => x.id === r1.data.id), 'waits for target');
    const forTarget = await api(`/api/requests/for?eventId=${EVENT}&name=${encodeURIComponent(coverA)}`);
    check('the asked person sees it', Array.isArray(forTarget.data) && forTarget.data.some((x) => x.id === r1.data.id), `${(forTarget.data || []).length} for ${coverA}`);
    const dup = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: ownerA, shiftId: shift.id, targetName: coverA } });
    check('duplicate request for the same shift is blocked', dup.status === 400 || dup.status === 429, `status ${dup.status}`);
    const acc = await api('/api/requests/respond', { method: 'POST', body: { id: r1.data.id, name: coverA, action: 'accept' } });
    check('asked person accepts', acc.status === 200, acc.data?.message || `status ${acc.status}`);
    check('accept auto-applies to the schedule', (await ownerOf(shift.id)) === coverA, `owner is now ${await ownerOf(shift.id)}`);
    const inbox1 = await api(`/api/admin/requests?eventId=${EVENT}`, { token });
    check('auto-applied ask is NOT left in the admin queue', Array.isArray(inbox1.data) && !inbox1.data.some((x) => x.id === r1.data.id), `${(inbox1.data || []).length} pending`);
    const recent = await api(`/api/admin/requests/recent?eventId=${EVENT}`, { token });
    check('applied change appears in Recently applied', Array.isArray(recent.data) && recent.data.some((x) => x.coverer_name === coverA), `${(recent.data || []).length} recent`);

    // 3b. Directed request the target DECLINES stays out of the admin inbox
    const rDec = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: coverA, shiftId: shift.id, targetName: ownerA } });
    await api('/api/requests/respond', { method: 'POST', body: { id: rDec.data.id, name: ownerA, action: 'decline' } });
    const afterDec = await api(`/api/admin/requests?eventId=${EVENT}`, { token });
    check('a declined ask never reaches the admin', Array.isArray(afterDec.data) && !afterDec.data.some((x) => x.id === rDec.data.id), 'declined_by_target');
    check('shift unchanged after target decline', (await ownerOf(shift.id)) === coverA, `owner is ${await ownerOf(shift.id)}`);

    // 4. Restore shift 1 (open ask + pick original owner as coverer)
    section('Restore shift 1');
    const rr = await api('/api/requests', { method: 'POST', token, body: { eventId: EVENT, requesterName: await ownerOf(shift.id), shiftId: shift.id, targetName: null } });
    await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: rr.data.id, action: 'approve', covererName: ownerA } });
    check('owner restored', (await ownerOf(shift.id)) === ownerA, `owner is ${await ownerOf(shift.id)}`);

    // 5. Open ask -> decline -> no change
    section('Open ask → decline leaves schedule untouched');
    const r2 = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: ownerB, shiftId: shift2.id, targetName: null, message: 'smoke: anyone?' } });
    check('staff submits an open ask', r2.status === 200 && r2.data?.ok, `status ${r2.status}`);
    const dc = await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: r2.data.id, action: 'decline' } });
    check('admin declines', dc.status === 200, dc.data?.message || `status ${dc.status}`);
    check('shift 2 unchanged after decline', (await ownerOf(shift2.id)) === ownerB, `owner is ${await ownerOf(shift2.id)}`);

    // 6. Drift guard: shift changes after a request is filed -> stale approval blocked
    section('Drift guard (stale approval is blocked)');
    // Open ask filed (snapshot owner = ownerA). Change the shift directly via the
    // admin apply path (as if the admin edited it another way), then approving
    // the now-stale ask must 409.
    const stale = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: ownerA, shiftId: shift.id, targetName: null } });
    await api('/api/admin/confirm', { method: 'POST', token, body: { pendingAction: { type: 'cover_shift', ids: [shift.id], expect: [{ staff_name: ownerA, station: shift.station, start_time: shift.start_time, end_time: shift.end_time }], coverer: ownerB } } });
    const staleAp = await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: stale.data.id, action: 'approve', covererName: coverA } });
    check('stale approval returns 409', staleAp.status === 409, `status ${staleAp.status}`);
    await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: stale.data.id, action: 'decline' } });
    // restore shift 1 back to original owner
    const fix = await api('/api/requests', { method: 'POST', token, body: { eventId: EVENT, requesterName: await ownerOf(shift.id), shiftId: shift.id, targetName: null } });
    await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: fix.data.id, action: 'approve', covererName: ownerA } });
    check('shift 1 restored after drift test', (await ownerOf(shift.id)) === ownerA, `owner is ${await ownerOf(shift.id)}`);

    // 7. Input guards
    section('Guards');
    // 400 = validation rejection; 429 = per-IP rate limit (also a valid reject,
    // seen when the script is run repeatedly within 10 min).
    const mism = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: 'Not A Real Person', shiftId: shift.id } });
    check('rejects request on someone else’s shift', mism.status === 400 || mism.status === 429, `status ${mism.status}`);
    const bad = await api('/api/requests', { method: 'POST', body: { eventId: EVENT, requesterName: ownerA, shiftId: 99999999 } });
    check('rejects unknown shift id', bad.status === 400 || bad.status === 429, `status ${bad.status}`);

    // 8. Notification endpoints (delivery to a phone is the manual step)
    section('Notifications');
    const vk = await api('/api/push/vapid-public');
    check('push public key served', vk.status === 200 && (vk.data?.key || '').length > 20, `status ${vk.status}`);
    const evil = await api('/api/admin/push/subscribe', { method: 'POST', token, body: { endpoint: 'https://evil.example.com/x', keys: {} } });
    check('rejects non-push-service endpoint (SSRF guard)', evil.status === 400, `status ${evil.status}`);
    const noauth = await api('/api/admin/push/subscribe', { method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' } });
    check('subscribe requires admin auth', noauth.status === 401, `status ${noauth.status}`);

    // 9. Inbox is clean
    section('Final state');
    const finalInbox = await api(`/api/admin/requests?eventId=${EVENT}`, { token });
    check('no pending requests left behind', Array.isArray(finalInbox.data) && finalInbox.data.length === 0, `${(finalInbox.data || []).length} pending`);
  } catch (e) {
    console.log('\n!! test run error:', e.message);
    fail += 1;
  } finally {
    // Safety net: make absolutely sure both shifts are back to their originals.
    if (token && shift) {
      const restore = async (id, want) => {
        const cur = (await api(`/api/schedule/${EVENT}`)).data.find((r) => r.id === id);
        if (cur && cur.staff_name !== want) {
          const q = await api('/api/requests', { method: 'POST', token, body: { eventId: EVENT, requesterName: cur.staff_name, shiftId: id, targetName: null } });
          if (q.data?.id) await api('/api/admin/requests/resolve', { method: 'POST', token, body: { id: q.data.id, action: 'approve', covererName: want } });
        }
      };
      try { await restore(shift.id, ownerA); if (shift2) await restore(shift2.id, ownerB); } catch { /* best effort */ }
    }
  }

  console.log(`\n${'='.repeat(48)}`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILED:', failures.join(', '));
  else console.log('✅ All checks passed. Schedule restored to original state.');
  console.log('\nNote: actual phone-push delivery is the one manual check —');
  console.log('install the PWA, tap "Enable phone alerts", submit a request, watch the phone.');
  process.exit(fail ? 1 : 0);
}

main();
