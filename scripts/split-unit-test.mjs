// Pure-logic unit test for the partial-cover split math. No DB, no network —
// just exercises clampWindow + computeCoverSegments from src/db.js across the
// whole/leading/trailing/middle/invalid cases. Run: node scripts/split-unit-test.mjs
import { clampWindow, computeCoverSegments } from '../src/db.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}  — ${detail}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const shift = { staff_name: 'Owner', start_time: '13:30', end_time: '18:15' };

// --- clampWindow ---
check('clamp: valid sub-window kept', eq(clampWindow('13:30', '18:15', '14:00', '15:00'), { start: '14:00', end: '15:00' }));
check('clamp: missing window -> full shift', eq(clampWindow('13:30', '18:15', null, null), { start: '13:30', end: '18:15' }));
check('clamp: start before shift -> full shift', eq(clampWindow('13:30', '18:15', '12:00', '15:00'), { start: '13:30', end: '18:15' }));
check('clamp: end after shift -> full shift', eq(clampWindow('13:30', '18:15', '14:00', '19:00'), { start: '13:30', end: '18:15' }));
check('clamp: start >= end -> full shift', eq(clampWindow('13:30', '18:15', '15:00', '15:00'), { start: '13:30', end: '18:15' }));
check('clamp: unpadded hour normalized', eq(clampWindow('13:30', '18:15', '9:00', '10:00'), { start: '13:30', end: '18:15' }), 'out of range -> full');
check('clamp: exact full window', eq(clampWindow('13:30', '18:15', '13:30', '18:15'), { start: '13:30', end: '18:15' }));

// --- computeCoverSegments ---
// whole shift
let s = computeCoverSegments(shift, 'Coverer', { start: '13:30', end: '18:15' });
check('whole: no remainders', s.whole === true && s.remainders.length === 0);
check('whole: covered spans full shift, to coverer', eq(s.covered, { start: '13:30', end: '18:15', staff_name: 'Coverer' }));

// middle window -> 3 rows (2 remainders + covered)
s = computeCoverSegments(shift, 'Coverer', { start: '14:00', end: '15:00' });
check('middle: 2 remainders', s.remainders.length === 2 && s.whole === false);
check('middle: covered window to coverer', eq(s.covered, { start: '14:00', end: '15:00', staff_name: 'Coverer' }));
check('middle: leading remainder to owner', eq(s.remainders[0], { start: '13:30', end: '14:00', staff_name: 'Owner' }));
check('middle: trailing remainder to owner', eq(s.remainders[1], { start: '15:00', end: '18:15', staff_name: 'Owner' }));

// leading window (covers the start) -> 1 remainder (trailing)
s = computeCoverSegments(shift, 'Coverer', { start: '13:30', end: '15:00' });
check('leading: 1 remainder', s.remainders.length === 1 && s.whole === false);
check('leading: covered from shift start', eq(s.covered, { start: '13:30', end: '15:00', staff_name: 'Coverer' }));
check('leading: only trailing remainder', eq(s.remainders[0], { start: '15:00', end: '18:15', staff_name: 'Owner' }));

// trailing window (covers the end) -> 1 remainder (leading)
s = computeCoverSegments(shift, 'Coverer', { start: '17:00', end: '18:15' });
check('trailing: 1 remainder', s.remainders.length === 1 && s.whole === false);
check('trailing: covered to shift end', eq(s.covered, { start: '17:00', end: '18:15', staff_name: 'Coverer' }));
check('trailing: only leading remainder', eq(s.remainders[0], { start: '13:30', end: '17:00', staff_name: 'Owner' }));

// no covered minutes lost: covered + remainders exactly tile the shift
function tiles(segs) {
  const all = [segs.covered, ...segs.remainders].sort((a, b) => a.start.localeCompare(b.start));
  if (all[0].start !== shift.start_time || all[all.length - 1].end !== shift.end_time) return false;
  for (let i = 1; i < all.length; i += 1) if (all[i - 1].end !== all[i].start) return false;
  return true;
}
check('coverage tiles with no gap/overlap (middle)', tiles(computeCoverSegments(shift, 'C', { start: '14:00', end: '15:00' })));
check('coverage tiles with no gap/overlap (leading)', tiles(computeCoverSegments(shift, 'C', { start: '13:30', end: '16:00' })));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
