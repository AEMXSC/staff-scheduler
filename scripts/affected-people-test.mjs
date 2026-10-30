// Run: node scripts/affected-people-test.mjs
import assert from 'node:assert/strict';
import { affectedPeople } from '../src/db.js';

// Fake D1: returns the given rows and records the query's bound ids.
function fakeEnv(rows) {
  const env = {
    bound: null,
    DB: { prepare: () => ({ bind(...a) { env.bound = a; return this; }, all: async () => ({ results: rows }) }) },
  };
  return env;
}
const ana = { event_id: 'max-2026', staff_name: 'Ana' };
const ben = { event_id: 'max-2026', staff_name: 'Ben' };

let env = fakeEnv([]);
assert.deepEqual(
  await affectedPeople(env, { type: 'add_shift', row: { event_id: 'max-2026', staff_name: 'Ana' } }),
  { eventId: 'max-2026', names: ['Ana'] },
);

env = fakeEnv([ana, ben]);
assert.deepEqual(
  await affectedPeople(env, { type: 'swap_people', idsA: [1], idsB: [2, 3] }),
  { eventId: 'max-2026', names: ['Ana', 'Ben'] },
);
assert.deepEqual(env.bound, [1, 2, 3]);

for (const type of ['reassign_station', 'cancel_shift', 'edit_shift_time']) {
  assert.deepEqual(await affectedPeople(fakeEnv([ana]), { type, ids: [1] }), { eventId: 'max-2026', names: ['Ana'] });
}

assert.deepEqual(
  await affectedPeople(fakeEnv([ana]), { type: 'cover_shift', ids: [1], coverer: 'Ben' }),
  { eventId: 'max-2026', names: ['Ana', 'Ben'] },
);
assert.deepEqual(
  (await affectedPeople(fakeEnv([ana]), { type: 'cover_shift', ids: [1], coverer: 'Ana' })).names,
  ['Ana'],
);

assert.equal(await affectedPeople(fakeEnv([]), { type: 'cancel_shift', ids: [99] }), null);
assert.equal(await affectedPeople(fakeEnv([]), { type: 'unknown' }), null);

console.log('affected-people: all passed');
