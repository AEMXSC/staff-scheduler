export function findRows(schedule, {
  staff_name, day, station, is_floater,
} = {}) {
  return schedule.filter((r) => (!staff_name || r.staff_name.toLowerCase().includes(staff_name.toLowerCase()))
    && (!day || r.day.toLowerCase() === day.toLowerCase())
    && (!station || r.station.toLowerCase().includes(station.toLowerCase()))
    && (is_floater === undefined || r.is_floater === is_floater));
}

// "HH:MM" (24h, zero-padded) sorts correctly as a plain string -- no need
// to parse to minutes first.
export function sortRows(rows, sortBy, order) {
  const sorted = [...rows].sort((a, b) => a[sortBy].localeCompare(b[sortBy]));
  return order === 'desc' ? sorted.reverse() : sorted;
}

// For "who has the most/fewest shifts" style questions -- groups matching
// rows by a field, counts them, and sorts by count (desc by default, since
// "most" is the common case). A real count per group, not a model guess.
export function groupByCount(rows, field, order = 'desc') {
  const counts = new Map();
  rows.forEach((r) => counts.set(r[field], (counts.get(r[field]) || 0) + 1));
  const entries = [...counts.entries()].map(([key, count]) => ({ key, count }));
  entries.sort((a, b) => (order === 'asc' ? a.count - b.count : b.count - a.count));
  return entries;
}

export function diffTable(rows, newStationFor) {
  return {
    headers: ['Name', 'Day', 'Before', 'After'],
    rows: rows.map((r) => [r.staff_name, r.day, r.station, `${newStationFor(r)} ← changed`]),
  };
}

// Both propose (chat) and apply (confirm) re-derive the target rows from the
// live schedule rather than trusting a snapshot, so a confirm always acts on
// current state -- if the rows moved or vanished between propose and
// confirm, these return null and the caller reports the mismatch.
//
// staff_name is matched as a substring for convenience ("Andrew" should
// find "Andrew Hochradel"), but a write must never guess between two
// different people who share a substring -- distinctNames() below guards
// that for every write path.

function distinctNames(rows) {
  return [...new Set(rows.map((r) => r.staff_name))];
}

export function planReassign(schedule, { staff_name, day, new_station }) {
  const rows = findRows(schedule, { staff_name, day });
  if (!rows.length) return null;
  const names = distinctNames(rows);
  if (names.length > 1) return { ambiguous: names };
  return { rows, table: diffTable(rows, () => new_station) };
}

export function applyReassign(schedule, { staff_name, day, new_station }) {
  const rows = findRows(schedule, { staff_name, day });
  if (!rows.length || distinctNames(rows).length > 1) return 0;
  rows.forEach((r) => { r.station = new_station; });
  return rows.length;
}

export function planSwap(schedule, { staff_name_a, staff_name_b, day }) {
  const rowsA = findRows(schedule, { staff_name: staff_name_a, day });
  const rowsB = findRows(schedule, { staff_name: staff_name_b, day });
  if (!rowsA.length || !rowsB.length) return null;
  const namesA = distinctNames(rowsA);
  const namesB = distinctNames(rowsB);
  if (namesA.length > 1 || namesB.length > 1) return { ambiguous: [...namesA, ...namesB] };
  const stationA = rowsA[0].station;
  const stationB = rowsB[0].station;
  return {
    rows: [...rowsA, ...rowsB],
    table: diffTable(
      [...rowsA, ...rowsB],
      (r) => (rowsA.includes(r) ? stationB : stationA),
    ),
  };
}

export function applySwap(schedule, { staff_name_a, staff_name_b, day }) {
  const rowsA = findRows(schedule, { staff_name: staff_name_a, day });
  const rowsB = findRows(schedule, { staff_name: staff_name_b, day });
  if (!rowsA.length || !rowsB.length) return 0;
  if (distinctNames(rowsA).length > 1 || distinctNames(rowsB).length > 1) return 0;
  const stationA = rowsA[0].station;
  const stationB = rowsB[0].station;
  rowsA.forEach((r) => { r.station = stationB; });
  rowsB.forEach((r) => { r.station = stationA; });
  return rowsA.length + rowsB.length;
}
