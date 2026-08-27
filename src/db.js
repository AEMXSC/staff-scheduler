// D1 data layer. Reads for the staff-facing app and the AI's ad-hoc
// queries; id-targeted writes for the admin confirm flow.

const ROW_COLS = 'id, staff_name, day, date, start_time, end_time, station, is_floater, group_name';

// Times are zero-padded 'HH:MM' 24h everywhere -- text comparison, sorting,
// and toMin() all rely on it. Normalize a write value to that form (accepting
// an unpadded hour like "9:00"), or null if it isn't a real time-of-day.
function normalizeTime(t) {
  if (typeof t !== 'string') return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export async function getSchedule(env, eventId) {
  const { results } = await env.DB
    .prepare(`SELECT ${ROW_COLS} FROM shifts WHERE event_id = ? ORDER BY id`)
    .bind(eventId)
    .all();
  return results.map((r) => ({ ...r, is_floater: !!r.is_floater, group: r.group_name }));
}

export function distinctDays(schedule) {
  return [...new Set(schedule.map((r) => r.day))];
}

// --- bulk replace (admin uploads) ---
const MAX_UPLOAD_ROWS = 5000;

export async function replaceSchedule(env, eventId, rows) {
  if (!Array.isArray(rows) || !rows.length) return { error: 'No rows.' };
  if (rows.length > MAX_UPLOAD_ROWS) return { error: `Too many rows (max ${MAX_UPLOAD_ROWS}).` };
  const clean = [];
  for (const r of rows) {
    if (!r.staff_name || !r.day || !r.start_time || !r.end_time || !r.station) {
      return { error: 'A row is missing required fields (name, day, start, end, station).' };
    }
    clean.push([eventId, `${r.staff_name}`, `${r.day}`, r.date ? `${r.date}` : null,
      `${r.start_time}`, `${r.end_time}`, `${r.station}`, r.is_floater ? 1 : 0,
      r.group ? `${r.group}` : null]);
  }
  const insert = env.DB.prepare(`INSERT INTO shifts
    (event_id, staff_name, day, date, start_time, end_time, station, is_floater, group_name)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shifts WHERE event_id = ?').bind(eventId),
    ...clean.map((c) => insert.bind(...c)),
  ]);
  return { inserted: clean.length };
}

export async function getContacts(env, eventId) {
  const { results } = await env.DB
    .prepare('SELECT name, email, phone, slack, whatsapp, title, manager FROM contacts WHERE event_id = ? ORDER BY name')
    .bind(eventId)
    .all();
  return results;
}

// Staff-facing directory (name/title/email/phone/slack) -- the tap-to-Slack /
// tap-to-call list. Excludes manager. Served on a public route by request.
export async function getDirectory(env, eventId) {
  const { results } = await env.DB
    .prepare('SELECT name, title, email, phone, slack FROM contacts WHERE event_id = ? ORDER BY name')
    .bind(eventId)
    .all();
  return results;
}

export async function replaceContacts(env, eventId, rows) {
  if (!Array.isArray(rows) || !rows.length) return { error: 'No rows.' };
  if (rows.length > MAX_UPLOAD_ROWS) return { error: `Too many rows (max ${MAX_UPLOAD_ROWS}).` };
  const s = (v) => (v ? `${v}` : null);
  const clean = [];
  for (const r of rows) {
    if (!r.name) return { error: 'A contact row is missing a name.' };
    clean.push([eventId, `${r.name}`, s(r.email), s(r.phone), s(r.slack), s(r.whatsapp), s(r.title), s(r.manager)]);
  }
  const insert = env.DB.prepare('INSERT INTO contacts (event_id, name, email, phone, slack, whatsapp, title, manager) VALUES (?,?,?,?,?,?,?,?)');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contacts WHERE event_id = ?').bind(eventId),
    ...clean.map((c) => insert.bind(...c)),
  ]);
  return { inserted: clean.length };
}

// --- staff-initiated change requests (proposals; admin approval applies them) ---
const MAX_MESSAGE_LEN = 500;

// Public path: a staff member requests a change to their OWN shift. We trust
// the shift row (day/station/times) from the DB, not the client, and only
// accept a request whose requester actually holds that shift.
export async function createRequest(env, eventId, { requesterName, shiftId, targetName, message }) {
  const name = typeof requesterName === 'string' ? requesterName.trim().slice(0, 100) : '';
  const sid = Number(shiftId);
  if (!name) return { error: 'noname' };
  if (!Number.isInteger(sid)) return { error: 'noshift' };
  const shift = await env.DB
    .prepare('SELECT id, staff_name, day, station, start_time, end_time FROM shifts WHERE id = ? AND event_id = ?')
    .bind(sid, eventId)
    .first();
  if (!shift) return { error: 'noshift' };
  if (shift.staff_name.trim().toLowerCase() !== name.toLowerCase()) return { error: 'mismatch' };
  // One open request per shift: block a duplicate while one is still in flight
  // (waiting on the target or on the admin).
  const open = await env.DB
    .prepare("SELECT id FROM change_requests WHERE event_id = ? AND shift_id = ? AND status IN ('awaiting_target','awaiting_admin')")
    .bind(eventId, shift.id)
    .first();
  if (open) return { error: 'exists' };
  const target = typeof targetName === 'string' && targetName.trim() ? targetName.trim().slice(0, 100) : null;
  const msg = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_LEN) : null;
  // Directed asks wait for the named person to accept first; open asks go
  // straight to the admin queue.
  const status = target ? 'awaiting_target' : 'awaiting_admin';
  const res = await env.DB
    .prepare(`INSERT INTO change_requests
      (event_id, requester_name, shift_id, day, station, start_time, end_time, target_name, message, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, ?)`)
    .bind(eventId, shift.staff_name, shift.id, shift.day, shift.station, shift.start_time, shift.end_time, target, msg, status, new Date().toISOString())
    .run();
  return { ok: true, id: res.meta?.last_row_id, status };
}

// Admin inbox: only requests ready for an approve/decline decision.
export async function listPendingRequests(env, eventId) {
  const { results } = await env.DB
    .prepare('SELECT * FROM change_requests WHERE event_id = ? AND status = ? ORDER BY created_at')
    .bind(eventId, 'awaiting_admin')
    .all();
  return results;
}

// Staff inbox: directed asks awaiting THIS person's accept/decline.
export async function listRequestsForTarget(env, eventId, name) {
  // Deliberately excludes `message`: this endpoint is public (no staff login),
  // so the free-text reason is not exposed. The asked person sees who is asking
  // and the shift, which is enough to accept/decline (and is already public
  // schedule info). The reason stays admin-only.
  const { results } = await env.DB
    .prepare(`SELECT id, requester_name, day, station, start_time, end_time
              FROM change_requests WHERE event_id = ? AND status = 'awaiting_target' AND lower(target_name) = lower(?)
              ORDER BY created_at`)
    .bind(eventId, name)
    .all();
  return results;
}

// The asked person accepts or declines. Accept = mutual consent (requester
// asked + target agreed), so it APPLIES the cover immediately (drift-guarded)
// and the admin is notified after the fact. Decline just closes it.
export async function respondToRequest(env, id, name, action) {
  const r = await getRequestById(env, id);
  if (!r) return { error: 'notfound' };
  if (r.status !== 'awaiting_target') return { error: 'notpending' };
  if (!r.target_name || r.target_name.trim().toLowerCase() !== String(name || '').trim().toLowerCase()) return { error: 'mismatch' };

  if (action === 'decline') {
    await env.DB
      .prepare('UPDATE change_requests SET status = ?, resolved_at = ? WHERE id = ?')
      .bind('declined_by_target', new Date().toISOString(), id)
      .run();
    return { ok: true, status: 'declined_by_target' };
  }

  // accept -> apply now, guarding that the shift still matches what was asked
  const plan = await planCoverShift(env, r.event_id, {
    shift_id: r.shift_id,
    coverer_name: r.target_name,
    expect: { staff_name: r.requester_name, station: r.station, start_time: r.start_time, end_time: r.end_time },
  });
  if (plan.error) return { error: 'shiftgone' };
  const applied = await applyPending(env, plan.pending);
  if (applied.drift) return { error: 'drift' };
  if (applied.error) return { error: 'applyfail' };
  await env.DB
    .prepare('UPDATE change_requests SET status = ?, coverer_name = ?, resolved_at = ? WHERE id = ?')
    .bind('approved', r.target_name, new Date().toISOString(), id)
    .run();
  return { ok: true, status: 'approved', applied: true, req: r };
}

// Recently applied changes (auto-applied accepts + admin-approved open asks),
// so the admin can see what happened without approving anything.
export async function listRecentChanges(env, eventId) {
  const { results } = await env.DB
    .prepare(`SELECT requester_name, coverer_name, day, station, start_time, end_time, resolved_at
              FROM change_requests WHERE event_id = ? AND status = 'approved'
              ORDER BY resolved_at DESC LIMIT 10`)
    .bind(eventId)
    .all();
  return results;
}

export async function getRequestById(env, id) {
  return env.DB.prepare('SELECT * FROM change_requests WHERE id = ?').bind(id).first();
}

export async function markRequest(env, id, status, covererName) {
  await env.DB
    .prepare('UPDATE change_requests SET status = ?, coverer_name = ?, resolved_at = ? WHERE id = ?')
    .bind(status, covererName || null, new Date().toISOString(), id)
    .run();
}

// --- web push subscriptions ---
// staff_name NULL = admin device (broadcast queue alerts); set = that person's
// device (targeted "you were asked" alerts).
export async function savePushSubscription(env, sub, staffName = null) {
  if (!sub || !sub.endpoint) return { error: 'no endpoint' };
  const name = staffName ? `${staffName}`.trim().slice(0, 100) : null;
  await env.DB
    .prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, staff_name) VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, staff_name = excluded.staff_name`)
    .bind(sub.endpoint, sub.keys?.p256dh || null, sub.keys?.auth || null, new Date().toISOString(), name)
    .run();
  return { ok: true };
}

// Admin devices (broadcast queue alerts).
export async function listPushSubscriptions(env) {
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE staff_name IS NULL').all();
  return results;
}

// A specific person's devices (targeted alerts).
export async function listStaffSubscriptions(env, name) {
  const { results } = await env.DB
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE lower(staff_name) = lower(?)')
    .bind(name)
    .all();
  return results;
}

export async function deletePushSubscription(env, endpoint) {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}

// --- read-only SQL guard for AI-authored queries ---
// The model composes a SELECT; this makes it structurally impossible for
// that SELECT to mutate anything before it reaches D1.
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|TRUNCATE|GRANT|REVOKE)\b/i;

export function isReadOnlySelect(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return false;
  if (trimmed.includes(';')) return false; // no multi-statement
  if (!/^\(*\s*(with|select)\b/i.test(trimmed)) return false; // must be SELECT / CTE
  if (FORBIDDEN.test(trimmed)) return false;
  return true;
}

export async function runReadOnly(env, sql) {
  const { results } = await env.DB.prepare(sql).all();
  return results;
}

// --- id-targeted writes (only path that mutates the schedule) ---

function distinctNames(rows) {
  return [...new Set(rows.map((r) => r.staff_name))];
}

async function matchRows(env, eventId, staffName, day) {
  const { results } = await env.DB
    .prepare(`SELECT id, staff_name, day, station FROM shifts
              WHERE event_id = ? AND lower(staff_name) LIKE ? AND day = ?`)
    .bind(eventId, `%${staffName.toLowerCase()}%`, day)
    .all();
  return results;
}

export async function planReassign(env, eventId, { staff_name, day, new_station }) {
  const rows = await matchRows(env, eventId, staff_name, day);
  if (!rows.length) return { error: 'notfound' };
  const names = distinctNames(rows);
  if (names.length > 1) return { ambiguous: names };
  return {
    table: {
      headers: ['Name', 'Day', 'Before', 'After'],
      rows: rows.map((r) => [r.staff_name, r.day, r.station, `${new_station} ← changed`]),
    },
    pending: { type: 'reassign_station', ids: rows.map((r) => r.id), expect: rows.map((r) => r.station), new_station },
  };
}

export async function planSwap(env, eventId, { staff_name_a, staff_name_b, day }) {
  const a = await matchRows(env, eventId, staff_name_a, day);
  const b = await matchRows(env, eventId, staff_name_b, day);
  if (!a.length || !b.length) return { error: 'notfound' };
  const names = [...distinctNames(a), ...distinctNames(b)];
  if (distinctNames(a).length > 1 || distinctNames(b).length > 1) return { ambiguous: names };
  const stationA = a[0].station;
  const stationB = b[0].station;
  return {
    table: {
      headers: ['Name', 'Day', 'Before', 'After'],
      rows: [
        ...a.map((r) => [r.staff_name, r.day, r.station, `${stationB} ← changed`]),
        ...b.map((r) => [r.staff_name, r.day, r.station, `${stationA} ← changed`]),
      ],
    },
    pending: {
      type: 'swap_people',
      idsA: a.map((r) => r.id), idsB: b.map((r) => r.id),
      expectA: a.map((r) => r.station), expectB: b.map((r) => r.station),
      stationA, stationB,
    },
  };
}

// Identify target shift rows for cancel/edit: name + day, optionally narrowed
// by station and/or current start_time when a person has several shifts.
async function matchShifts(env, eventId, { staff_name, day, station, start_time }) {
  const clauses = ['event_id = ?', 'lower(staff_name) LIKE ?', 'day = ?'];
  const binds = [eventId, `%${staff_name.toLowerCase()}%`, day];
  if (station) { clauses.push('lower(station) LIKE ?'); binds.push(`%${station.toLowerCase()}%`); }
  if (start_time) { clauses.push('start_time = ?'); binds.push(normalizeTime(start_time) || start_time); }
  const { results } = await env.DB
    .prepare(`SELECT id, staff_name, day, date, start_time, end_time, station, is_floater
              FROM shifts WHERE ${clauses.join(' AND ')}`)
    .bind(...binds)
    .all();
  return results;
}

export async function planAddShift(env, eventId, {
  staff_name, day, start_time, end_time, station, is_floater,
}) {
  const st = normalizeTime(start_time);
  const et = normalizeTime(end_time);
  if (!st || !et) return { badTime: true };
  // Borrow the calendar date other shifts on that day already use, if any.
  const sample = await env.DB
    .prepare('SELECT date FROM shifts WHERE event_id = ? AND day = ? AND date IS NOT NULL LIMIT 1')
    .bind(eventId, day)
    .first();
  const row = {
    event_id: eventId, staff_name, day, date: sample?.date || null,
    start_time: st, end_time: et, station, is_floater: is_floater ? 1 : 0,
  };
  return {
    table: {
      headers: ['Name', 'Day', 'Start', 'End', 'Station'],
      rows: [[staff_name, day, st, et, `${station}${is_floater ? ' (floater)' : ''} ← new`]],
    },
    pending: { type: 'add_shift', row },
  };
}

export async function planCancelShift(env, eventId, args) {
  const rows = await matchShifts(env, eventId, args);
  if (!rows.length) return { error: 'notfound' };
  const names = distinctNames(rows);
  if (names.length > 1) return { ambiguous: names };
  if (rows.length > 1) return { manyShifts: rows.map((r) => `${r.station} ${r.start_time}-${r.end_time}`) };
  const r = rows[0];
  return {
    table: {
      headers: ['Name', 'Day', 'Station', 'Shift'],
      rows: [[r.staff_name, r.day, r.station, `${r.start_time}-${r.end_time} ← remove`]],
    },
    pending: {
      type: 'cancel_shift',
      ids: [r.id],
      expect: [{ station: r.station, start_time: r.start_time, end_time: r.end_time }],
    },
  };
}

export async function planEditShiftTime(env, eventId, args) {
  const ns = normalizeTime(args.new_start_time);
  const ne = normalizeTime(args.new_end_time);
  if (!ns || !ne) return { badTime: true };
  const rows = await matchShifts(env, eventId, args);
  if (!rows.length) return { error: 'notfound' };
  const names = distinctNames(rows);
  if (names.length > 1) return { ambiguous: names };
  if (rows.length > 1) return { manyShifts: rows.map((r) => `${r.station} ${r.start_time}-${r.end_time}`) };
  const r = rows[0];
  return {
    table: {
      headers: ['Name', 'Day', 'Station', 'Before', 'After'],
      rows: [[r.staff_name, r.day, r.station, `${r.start_time}-${r.end_time}`, `${ns}-${ne} ← changed`]],
    },
    pending: {
      type: 'edit_shift_time',
      ids: [r.id],
      expect: [{ start_time: r.start_time, end_time: r.end_time }],
      new_start_time: ns,
      new_end_time: ne,
    },
  };
}

// Per-slot headcount across a day. Buckets in JS (two plain queries) rather
// than a recursive CTE -- simpler and reliable. Feeds "which hours are
// thinnest/busiest" questions with exact per-slot counts to reason over.
function toMin(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
}

export async function coverageBySlot(env, eventId, day, slotMin = 30) {
  const { results } = await env.DB
    .prepare('SELECT start_time, end_time FROM shifts WHERE event_id = ? AND day = ?')
    .bind(eventId, day)
    .all();
  if (!results.length) return [];
  const spans = results.map((r) => [toMin(r.start_time), toMin(r.end_time)]);
  const lo = Math.min(...spans.map((s) => s[0]));
  const hi = Math.max(...spans.map((s) => s[1]));
  const out = [];
  for (let v = lo; v < hi; v += slotMin) {
    const slot = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    out.push({ slot, headcount: spans.filter(([s, e]) => s <= v && e > v).length });
  }
  return out;
}

// Re-reads rows by id and verifies the given fields still match -- generalises
// the station-only drift check to any column set (times, station).
async function verifyShiftsUnchanged(env, ids, expected) {
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB
    .prepare(`SELECT id, staff_name, station, start_time, end_time FROM shifts WHERE id IN (${placeholders}) ORDER BY id`)
    .bind(...ids)
    .all();
  if (results.length !== ids.length) return false;
  const byId = new Map(results.map((r) => [r.id, r]));
  return ids.every((id, i) => {
    const cur = byId.get(id);
    return cur && Object.keys(expected[i]).every((k) => cur[k] === expected[i][k]);
  });
}

// Re-reads the exact rows by id and verifies they still hold the station the
// diff was built from -- so a confirm can't apply against drifted data.
async function verifyUnchanged(env, ids, expected) {
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB
    .prepare(`SELECT id, station FROM shifts WHERE id IN (${placeholders}) ORDER BY id`)
    .bind(...ids)
    .all();
  if (results.length !== ids.length) return false;
  const byId = new Map(results.map((r) => [r.id, r.station]));
  return ids.every((id, i) => byId.get(id) === expected[i]);
}

async function setStations(env, ids, station) {
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE shifts SET station = ? WHERE id IN (${placeholders})`)
    .bind(station, ...ids)
    .run();
}

async function setStaff(env, ids, staffName) {
  const placeholders = ids.map(() => '?').join(',');
  await env.DB.prepare(`UPDATE shifts SET staff_name = ? WHERE id IN (${placeholders})`)
    .bind(staffName, ...ids)
    .run();
}

// Reassign a single shift to a different PERSON (the op behind an approved
// cover request). `expect` is the snapshot captured when the request was FILED
// (owner/station/time) -- the drift guard compares the shift's CURRENT state to
// that, so an approval is rejected if the shift changed in the meantime.
export async function planCoverShift(env, eventId, { shift_id, coverer_name, expect }) {
  if (!coverer_name) return { error: 'nocoverer' };
  const r = await env.DB
    .prepare('SELECT id FROM shifts WHERE id = ? AND event_id = ?')
    .bind(shift_id, eventId)
    .first();
  if (!r) return { error: 'notfound' };
  return {
    pending: {
      type: 'cover_shift',
      ids: [shift_id],
      expect: [{
        staff_name: expect.staff_name,
        station: expect.station,
        start_time: expect.start_time,
        end_time: expect.end_time,
      }],
      coverer: `${coverer_name}`,
    },
  };
}

export async function applyPending(env, pending) {
  if (pending.type === 'reassign_station') {
    if (!(await verifyUnchanged(env, pending.ids, pending.expect))) return { drift: true };
    await setStations(env, pending.ids, pending.new_station);
    return { updates: pending.ids.length };
  }
  if (pending.type === 'swap_people') {
    if (!(await verifyUnchanged(env, pending.idsA, pending.expectA))
      || !(await verifyUnchanged(env, pending.idsB, pending.expectB))) return { drift: true };
    await setStations(env, pending.idsA, pending.stationB);
    await setStations(env, pending.idsB, pending.stationA);
    return { updates: pending.idsA.length + pending.idsB.length };
  }
  if (pending.type === 'add_shift') {
    const r = pending.row;
    // Idempotency guard: a retried/replayed confirm must not double-insert.
    const dupe = await env.DB
      .prepare(`SELECT id FROM shifts WHERE event_id=? AND staff_name=? AND day=?
                AND start_time=? AND end_time=? AND station=?`)
      .bind(r.event_id, r.staff_name, r.day, r.start_time, r.end_time, r.station)
      .first();
    if (dupe) return { duplicate: true };
    await env.DB.prepare(`INSERT INTO shifts
      (event_id, staff_name, day, date, start_time, end_time, station, is_floater, group_name)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(r.event_id, r.staff_name, r.day, r.date, r.start_time, r.end_time, r.station, r.is_floater, null)
      .run();
    return { updates: 1 };
  }
  if (pending.type === 'cancel_shift') {
    if (!(await verifyShiftsUnchanged(env, pending.ids, pending.expect))) return { drift: true };
    const placeholders = pending.ids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM shifts WHERE id IN (${placeholders})`).bind(...pending.ids).run();
    return { updates: pending.ids.length };
  }
  if (pending.type === 'edit_shift_time') {
    if (!(await verifyShiftsUnchanged(env, pending.ids, pending.expect))) return { drift: true };
    await env.DB.prepare('UPDATE shifts SET start_time = ?, end_time = ? WHERE id = ?')
      .bind(pending.new_start_time, pending.new_end_time, pending.ids[0])
      .run();
    return { updates: 1 };
  }
  if (pending.type === 'cover_shift') {
    if (!(await verifyShiftsUnchanged(env, pending.ids, pending.expect))) return { drift: true };
    await setStaff(env, pending.ids, pending.coverer);
    return { updates: pending.ids.length };
  }
  return { error: true };
}
