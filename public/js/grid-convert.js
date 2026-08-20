// Browser port of scripts/convert-ibc-schedule.py — turns the IBC grid
// layout (person rows × time-slot columns, two shift blocks) into flat
// shift rows. Operates on a { sheetName: rows[][] } map of cell strings
// (0-indexed), so it's identical whether fed by SheetJS in the browser or
// by a node parity test. Parity-tested against the Python output.

const SECTION_HEADERS = new Set(['Demo Artists', 'ATE Floaters', 'Info Counter', 'Partner Booth']);
const SHEET_DATES = {
  Friday: '2026-09-11',
  Saturday: '2026-09-12',
  Sunday: '2026-09-13',
  Monday: '2026-09-14',
};

const HEADER_ROW = 4; // 0-indexed (Python row 5)
const FIRST_DATA_ROW = 5; // 0-indexed (Python row 6)

function isBlank(v) {
  return v === undefined || v === null || v === '' || v === ' ' || String(v).trim() === '';
}

function parseTime(label) {
  const m = String(label).trim().match(/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mnt = parseInt(m[2] || '0', 10);
  const ap = m[3].toUpperCase();
  if (ap === 'P' && h !== 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(mnt).padStart(2, '0')}`;
}

function shiftEndTimes(grid, sheetName, warnings) {
  const ends = [];
  for (const r of [0, 1]) {
    const label = String((grid[r] && grid[r][1]) || '').trim(); // column B
    const m = label.match(/[-–—]\s*([\d:APM.\s]+)$/i);
    const end = m ? parseTime(m[1]) : null;
    if (end === null) warnings.push(`${sheetName}: could not parse shift ${r + 1} end time from "${label}"`);
    ends.push(end);
  }
  return ends;
}

function buildColumnMap(grid, sheetName) {
  const header = grid[HEADER_ROW] || [];
  const cols = {};
  let shift = 0;
  let pendingBump = false;
  let recorded = false;
  for (let c = 0; c < header.length; c++) {
    const val = header[c];
    if (isBlank(val)) {
      if (recorded) pendingBump = true;
      continue;
    }
    if (pendingBump) { shift += 1; pendingBump = false; }
    if (shift > 1) {
      throw new Error(`${sheetName}: more than 2 shift blocks in the header row (unexpected blank spacer?).`);
    }
    const t = parseTime(String(val));
    if (!t) continue;
    cols[c] = { start: t, shift };
    recorded = true;
  }
  return cols;
}

function colEndTime(colIndices, idxPos, cols, shiftEnds) {
  const cur = cols[colIndices[idxPos]];
  if (idxPos + 1 < colIndices.length) {
    const nxt = cols[colIndices[idxPos + 1]];
    if (nxt.shift === cur.shift) return nxt.start;
  }
  return shiftEnds[cur.shift];
}

export function convertGrid(sheetsMap) {
  const rowsOut = [];
  const warnings = [];

  for (const [sheetName, date] of Object.entries(SHEET_DATES)) {
    const grid = sheetsMap[sheetName];
    if (!grid) continue;

    const cols = buildColumnMap(grid, sheetName);
    const colIndices = Object.keys(cols).map(Number).sort((a, b) => a - b);
    const shiftEnds = shiftEndTimes(grid, sheetName, warnings);

    let currentGroup = null;
    for (let r = FIRST_DATA_ROW; r < grid.length; r++) {
      const row = grid[r] || [];
      const rawName = row[0];
      const name = typeof rawName === 'string' ? rawName.trim() : (isBlank(rawName) ? null : String(rawName).trim());
      if (!name) continue;

      if (SECTION_HEADERS.has(name)) { currentGroup = name; continue; }

      const hasAnySlot = colIndices.some((c) => !isBlank(row[c]));
      if (!hasAnySlot) continue;

      if (name.toUpperCase().includes('TBD')) warnings.push(`${sheetName}: unresolved TBD row -> "${name}"`);

      let runStation = null;
      let runStartIdx = null;
      const flush = (endPos) => {
        rowsOut.push({
          staff_name: name,
          day: sheetName,
          date,
          start_time: cols[colIndices[runStartIdx]].start,
          end_time: colEndTime(colIndices, endPos, cols, shiftEnds),
          station: runStation,
          is_floater: runStation.toLowerCase().includes('floater'),
          group: currentGroup,
        });
      };

      for (let i = 0; i < colIndices.length; i++) {
        const v = row[colIndices[i]];
        const station = (typeof v === 'string' && !isBlank(v)) ? v.trim() : null;
        if (station !== runStation) {
          if (runStation !== null) flush(i - 1);
          runStation = station;
          runStartIdx = i;
        }
      }
      if (runStation !== null) flush(colIndices.length - 1);
    }
  }

  return { rows: rowsOut, warnings };
}
