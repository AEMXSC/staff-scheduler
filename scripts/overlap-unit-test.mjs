// Pure-logic unit test for overlappingShifts (the admin coverer double-booking
// warning). No DB/DOM. Run: node scripts/overlap-unit-test.mjs
import { overlappingShifts } from '../public/js/schedule.js';

let pass = 0; let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}  — ${detail}`); }
};

const data = [
  { id: 1, staff_name: 'Karl Soule', day: 'Friday', station: 'Premiere Floater', start_time: '14:30', end_time: '18:15', is_floater: true },
  { id: 2, staff_name: 'Karl Soule', day: 'Friday', station: 'AI Assistant', start_time: '09:15', end_time: '12:30', is_floater: false },
  { id: 3, staff_name: 'Karl Soule', day: 'Saturday', station: 'Premiere Floater', start_time: '14:30', end_time: '18:15', is_floater: true },
  { id: 4, staff_name: 'Yolanda Xiao', day: 'Friday', station: 'Premiere Floater', start_time: '14:30', end_time: '18:15', is_floater: true },
];

// The covered window is Ben's shift (id 99) 3-4pm Friday; would Karl clash?
let r = overlappingShifts(data, 'Karl Soule', 'Friday', '15:00', '16:00', 99);
check('flags Karl (already on Premiere Floater that window)', r.length === 1 && r[0].id === 1);

// Empty / no coverer picked yet
check('no name -> no clashes', overlappingShifts(data, '', 'Friday', '15:00', '16:00', 99).length === 0);
check('null name -> no clashes', overlappingShifts(data, null, 'Friday', '15:00', '16:00', 99).length === 0);

// Yolanda also overlaps -> a non-doubling pick would need to be someone else
check('flags Yolanda too (second floater)', overlappingShifts(data, 'Yolanda Xiao', 'Friday', '15:00', '16:00', 99).length === 1);

// Non-overlapping: a window between Karl's morning demo (ends 12:30) and his
// afternoon floater (starts 14:30) clashes with neither.
check('truly free window -> 0 clashes', overlappingShifts(data, 'Karl Soule', 'Friday', '13:00', '14:00', 99).length === 0);

// Adjacent (touching, not overlapping): window ends exactly when floater starts
check('adjacent window (ends at 14:30) does not clash', overlappingShifts(data, 'Karl Soule', 'Friday', '13:30', '14:30', 99).length === 0);

// Different day is ignored
check('different day ignored (Saturday shift)', overlappingShifts(data, 'Karl Soule', 'Friday', '15:00', '16:00', 99).every((x) => x.day === 'Friday'));

// Excludes the shift being covered (so the requester's own row never self-flags)
check('excludeId removes the covered shift', overlappingShifts(data, 'Karl Soule', 'Friday', '15:00', '16:00', 1).length === 0);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
