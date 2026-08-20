// D1 data layer. Reads for the staff-facing app and the AI's ad-hoc
// queries; id-targeted writes for the admin confirm flow.

const ROW_COLS = 'staff_name, day, date, start_time, end_time, station, is_floater, group_name';

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
    .prepare('SELECT name, email, phone, slack, whatsapp FROM contacts WHERE event_id = ? ORDER BY name')
    .bind(eventId)
    .all();
  return results;
}

export async function replaceContacts(env, eventId, rows) {
  if (!Array.isArray(rows) || !rows.length) return { error: 'No rows.' };
  if (rows.length > MAX_UPLOAD_ROWS) return { error: `Too many rows (max ${MAX_UPLOAD_ROWS}).` };
  const clean = [];
  for (const r of rows) {
    if (!r.name) return { error: 'A contact row is missing a name.' };
    clean.push([eventId, `${r.name}`, r.email ? `${r.email}` : null, r.phone ? `${r.phone}` : null,
      r.slack ? `${r.slack}` : null, r.whatsapp ? `${r.whatsapp}` : null]);
  }
  const insert = env.DB.prepare('INSERT INTO contacts (event_id, name, email, phone, slack, whatsapp) VALUES (?,?,?,?,?,?)');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM contacts WHERE event_id = ?').bind(eventId),
    ...clean.map((c) => insert.bind(...c)),
  ]);
  return { inserted: clean.length };
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
  return { error: true };
}
