export function findRows(schedule, {
  staff_name, day, station, is_floater,
} = {}) {
  return schedule.filter((r) => (!staff_name || r.staff_name.toLowerCase() === staff_name.toLowerCase())
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

export function planReassign(schedule, { staff_name, day, new_station }) {
  const rows = findRows(schedule, { staff_name, day });
  if (!rows.length) return null;
  return { rows, table: diffTable(rows, () => new_station) };
}

export function applyReassign(schedule, { staff_name, day, new_station }) {
  const rows = findRows(schedule, { staff_name, day });
  if (!rows.length) return 0;
  rows.forEach((r) => { r.station = new_station; });
  return rows.length;
}

export function planSwap(schedule, { staff_name_a, staff_name_b, day }) {
  const rowsA = findRows(schedule, { staff_name: staff_name_a, day });
  const rowsB = findRows(schedule, { staff_name: staff_name_b, day });
  if (!rowsA.length || !rowsB.length) return null;
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
  const stationA = rowsA[0].station;
  const stationB = rowsB[0].station;
  rowsA.forEach((r) => { r.station = stationB; });
  rowsB.forEach((r) => { r.station = stationA; });
  return rowsA.length + rowsB.length;
}
