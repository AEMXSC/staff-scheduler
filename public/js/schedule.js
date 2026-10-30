import {
  getZonedNow, toMins, fmt12, escapeHtml,
} from './time-utils.js';

// IBC's fixed product order for the "Who's On Now" grid. Used as the default
// when an event doesn't define its own `stationOrder` (so IBC keeps its order
// with no config change). A new event supplies `stationOrder` (+ optional
// `stationAliases`) in its event JSON; an empty array means "no fixed order"
// (alphabetical), which is the interim for MAX until its station list is known.
const IBC_STATION_ORDER = [
  'Premiere (Color)', 'Premiere (Generative Workflows)', 'Premiere (AI Audio)',
  'After Effects', 'Photoshop', 'Substance', 'Stock', 'Firefly + Video',
  'AI Assistant', 'Frame.io 1', 'Frame.io 2', 'Frame.io 3',
  'Firefly Enterprise (Meeting Room Lobby)',
];
const IBC_STATION_ALIASES = {
  'premiere (color)': 'Premiere (Color)',
  'premiere pro': 'Premiere (Color)',
  'premiere (ai - gen media & audio)': 'Premiere (Generative Workflows)',
  'frame.io': 'Frame.io 1',
  'firefly e': 'Firefly Enterprise (Meeting Room Lobby)',
  'firefly e (mr)': 'Firefly Enterprise (Meeting Room Lobby)',
};

// Returns a station -> sort-index function for this event. Unknown stations sort
// to the end (then alphabetically via the comparator tiebreak).
function makeStationIndex(event) {
  const custom = event && Array.isArray(event.stationOrder);
  const order = custom ? event.stationOrder : IBC_STATION_ORDER;
  const aliases = custom ? (event.stationAliases || {}) : IBC_STATION_ALIASES;
  return (station) => {
    const key = String(station).trim().toLowerCase();
    const canonical = aliases[key] || order.find((s) => s.toLowerCase() === key);
    const i = canonical ? order.indexOf(canonical) : -1;
    return i === -1 ? order.length : i;
  };
}
// Display-only prettification, casing-fixes ONLY (e.g. sheet says "Premiere
// (COLOR)"). By design we do NOT unify the coarse Sat-Sun-Mon labels (Premiere
// Pro, Frame.io, Firefly E) to the granular Friday names -- those are shown
// verbatim as the source sheet has them; only their sort position is aliased.
const STATION_LABELS = { 'premiere (color)': 'Premiere (Color)' };
function displayStation(station) {
  return STATION_LABELS[String(station).trim().toLowerCase()] || station;
}

// Rows have arbitrary-length spans (e.g. "10:15-14:30"), not uniform slots,
// so the slot grid for "Who's On Now" is built from every distinct
// start/end boundary that appears in the day's data.
export function getDaySlots(data, dayName) {
  const bounds = new Set();
  data.filter((r) => r.day === dayName).forEach((r) => {
    bounds.add(r.start_time);
    bounds.add(r.end_time);
  });
  const sorted = [...bounds].sort((a, b) => toMins(a) - toMins(b));
  const slots = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    slots.push({ start: sorted[i], end: sorted[i + 1] });
  }
  return slots;
}

export function findSlotIdx(slots, totalMins) {
  const idx = slots.findIndex((s) => totalMins >= toMins(s.start) && totalMins < toMins(s.end));
  if (idx >= 0) return idx;
  return totalMins < toMins(slots[0]?.start || '00:00') ? 0 : slots.length - 1;
}

export function rowsActiveAt(data, dayName, totalMins) {
  return data.filter((r) => r.day === dayName
    && totalMins >= toMins(r.start_time) && totalMins < toMins(r.end_time));
}

export function getFreeFloaters(data, dayName, totalMins) {
  return rowsActiveAt(data, dayName, totalMins).filter((r) => r.is_floater);
}

// Shifts `name` already holds on `day` that overlap the window [start,end]
// (HH:MM), excluding `excludeId` (the shift being covered). Powers the admin
// warning that a proposed coverer is already on station in that window -- a
// soft heads-up, since a floater doubling up can be intentional.
export function overlappingShifts(data, name, day, start, end, excludeId) {
  if (!name) return [];
  const s = toMins(start);
  const e = toMins(end);
  return data.filter((r) => r.staff_name === name && r.day === day && r.id !== excludeId
    && toMins(r.start_time) < e && s < toMins(r.end_time));
}

// Station names on big events carry their area ("Acrobat · Demo A"); inside an
// area context the prefix is noise, so show just "Demo A".
function shortStation(r) {
  const prefix = r.group ? `${r.group} · ` : '';
  return prefix && r.station.startsWith(prefix) ? r.station.slice(prefix.length) : r.station;
}

function relativeWhen(date, startMins, zoned) {
  if (date === zoned.dateStr) {
    const m = startMins - zoned.totalMins;
    if (m < 60) return `in ${m} min`;
    return `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  }
  const days = Math.round((Date.parse(date) - Date.parse(zoned.dateStr)) / 86_400_000);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

// "On now" / "Next shift" hero at the top of My Schedule -- the first thing
// staff look for on a phone. Empty once their last shift has ended.
function nextShiftCard(mySlots, event, zoned) {
  const dateOf = Object.fromEntries(event.days.map((d) => [d.day, d.date]));
  const upcoming = mySlots
    .map((r) => ({ r, date: dateOf[r.day], s: toMins(r.start_time), e: toMins(r.end_time) }))
    .filter((x) => x.date && (x.date > zoned.dateStr || (x.date === zoned.dateStr && x.e > zoned.totalMins)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
  if (!upcoming.length) return '';
  const { r, date, s } = upcoming[0];
  const isNow = date === zoned.dateStr && s <= zoned.totalMins;
  const area = r.group && shortStation(r) !== r.station ? r.group : '';
  return `<div class="next-card${isNow ? ' next-card-now' : ''}">
    <div class="next-label">${isNow ? 'On now' : `Next shift · ${relativeWhen(date, s, zoned)}`}</div>
    <div class="next-station">${escapeHtml(shortStation(r))}</div>
    <div class="next-meta">${escapeHtml([area, `${r.day} ${fmt12(r.start_time)}–${fmt12(r.end_time)}`].filter(Boolean).join(' · '))}</div>
  </div>`;
}

// onRequestChange(slot), if given, is called with the exact slot object
// (not a re-derived guess) when its "Request change" button is clicked --
// wired up by index after render, so no slot data has to round-trip through
// HTML attributes.
export function renderMySchedule(container, data, selectedName, event, onRequestChange) {
  if (!selectedName) {
    container.innerHTML = '<p class="hint">Select your name above to see your schedule.</p>';
    return;
  }

  const mySlots = data.filter((r) => r.staff_name === selectedName);
  if (!mySlots.length) {
    container.innerHTML = `<p class="hint">No schedule found for "${escapeHtml(selectedName)}".</p>`;
    return;
  }

  const zoned = getZonedNow(event.timezone);
  const currentDay = event.days.find((d) => d.date === zoned.dateStr)?.day || null;
  const renderedSlots = [];

  const dayCards = event.days.map(({ day }) => {
    const slots = mySlots
      .filter((r) => r.day === day)
      .sort((a, b) => toMins(a.start_time) - toMins(b.start_time));
    if (!slots.length) return '';

    const isToday = day === currentDay;

    const slotItems = slots.map((slot) => {
      const isActive = isToday
        && zoned.totalMins >= toMins(slot.start_time)
        && zoned.totalMins < toMins(slot.end_time);
      const idx = renderedSlots.push(slot) - 1;
      const area = [slot.group && shortStation(slot) !== slot.station ? slot.group : '',
        slot.is_floater ? 'Backup / floater' : ''].filter(Boolean).join(' · ');

      return `<div class="slot${isActive ? ' slot-active' : ''}${slot.is_floater ? ' slot-floater' : ''}">
        <div class="slot-when"><span>${fmt12(slot.start_time)}</span><span>${fmt12(slot.end_time)}</span></div>
        <div class="slot-what">
          <div class="slot-station">${escapeHtml(shortStation(slot))}${isActive ? ' <span class="now-badge">NOW</span>' : ''}</div>
          ${area ? `<div class="slot-area${slot.is_floater ? ' floater-label' : ''}">${escapeHtml(area)}</div>` : ''}
        </div>
        <button class="slot-request-btn" data-idx="${idx}" aria-label="Request change: ${escapeHtml(slot.station)}, ${day} ${fmt12(slot.start_time)}">Request change</button>
      </div>`;
    }).join('');

    return `<div class="day-card${isToday ? ' day-today' : ''}">
      <div class="day-heading">
        <span class="day-name">${day}</span>
        <span class="day-count">${slots.length} shift${slots.length === 1 ? '' : 's'}</span>
        ${isToday ? '<span class="today-pill">Today</span>' : ''}
      </div>
      <div class="slots">${slotItems}</div>
    </div>`;
  }).filter(Boolean).join('');

  container.innerHTML = (dayCards ? nextShiftCard(mySlots, event, zoned) + dayCards : '')
    || '<p class="hint">No slots across any event day.</p>';

  if (onRequestChange) {
    container.querySelectorAll('.slot-request-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRequestChange(renderedSlots[Number(btn.dataset.idx)]));
    });
  }
}

// Persisted across slot-nav re-renders so the filter isn't lost on ‹/›.
let whosFilter = '';
// Areas the user has expanded; null until the first multi-area render picks a
// default (all open for a handful of areas, all closed for MAX-sized events).
let openAreas = null;

export function renderWhosOnNow(container, data, dayName, slotIdx, onSelectPerson, event) {
  const daySlots = getDaySlots(data, dayName);

  if (!daySlots.length) {
    container.innerHTML = '<p class="hint">No schedule data for this day.</p>';
    return;
  }

  const effectiveIdx = Math.max(0, Math.min(slotIdx, daySlots.length - 1));
  const slot = daySlots[effectiveIdx];
  const active = rowsActiveAt(data, dayName, toMins(slot.start));

  const primaries = active.filter((r) => !r.is_floater);
  const floaters = getFreeFloaters(data, dayName, toMins(slot.start));
  const stationIndex = makeStationIndex(event);
  // From the whole event, not this slot, so the layout doesn't flip between slots.
  const eventAreaCount = new Set(data.map((r) => r.group || 'Other')).size;
  const multiArea = eventAreaCount > 1;

  // Group stations by booth/area (group_name). Multi-area events (MAX) keep
  // floaters inside their own area; single-area events (IBC) keep the separate
  // "On backup" panel and look unchanged.
  const areas = new Map(); // area -> Map(station -> rows)
  (multiArea ? active : primaries).forEach((r) => {
    const area = r.group || 'Other';
    if (!areas.has(area)) areas.set(area, new Map());
    const byStation = areas.get(area);
    if (!byStation.has(r.station)) byStation.set(r.station, []);
    byStation.get(r.station).push(r);
  });

  const cardFor = (station, rows) => {
    const search = `${station} ${rows.map((r) => r.staff_name).join(' ')}`.toLowerCase();
    return `<div class="station-card" data-search="${escapeHtml(search)}">
      <div class="station-name">${escapeHtml(displayStation(station))}</div>
      <div class="station-people">${rows.map((r) => `<button class="chip chip-link" data-name="${escapeHtml(r.staff_name)}">${escapeHtml(r.staff_name)}</button>`).join('')}</div>
    </div>`;
  };

  const areaList = [...areas.entries()]
    .map(([area, byStation]) => {
      const stations = [...byStation.entries()].sort(([a], [b]) => (stationIndex(a) - stationIndex(b)) || a.localeCompare(b));
      const minIdx = Math.min(...stations.map(([s]) => stationIndex(s)));
      return { area, stations, minIdx };
    })
    .sort((a, b) => (a.minIdx - b.minIdx) || a.area.localeCompare(b.area));

  if (!openAreas) openAreas = new Set(eventAreaCount <= 6 ? data.map((r) => r.group || 'Other') : []);

  const rowFor = (station, rows) => {
    const floater = rows[0].is_floater;
    const search = `${rows[0].group || ''} ${station} ${rows.map((r) => r.staff_name).join(' ')}`.toLowerCase();
    return `<li class="area-row${floater ? ' area-row-floater' : ''}" data-search="${escapeHtml(search)}">
      <span class="area-station">${escapeHtml(displayStation(shortStation(rows[0])))}</span>
      <span class="area-people">${rows.map((r) => `<button class="chip chip-link${floater ? ' chip-floater' : ''}" data-name="${escapeHtml(r.staff_name)}">${escapeHtml(r.staff_name)}</button>`).join('')}</span>
    </li>`;
  };

  const areaBlocks = multiArea
    ? areaList.map(({ area, stations }) => {
      const ordered = [...stations].sort(([, a], [, b]) => Number(a[0].is_floater) - Number(b[0].is_floater));
      const people = new Set(ordered.flatMap(([, rows]) => rows.map((r) => r.staff_name))).size;
      return `<details class="area" data-area="${escapeHtml(area)}"${openAreas.has(area) ? ' open' : ''}>
        <summary class="area-summary"><span class="area-name">${escapeHtml(area)}</span><span class="area-count">${people} on</span></summary>
        <ul class="area-list">${ordered.map(([s, rows]) => rowFor(s, rows)).join('')}</ul>
      </details>`;
    }).join('')
    : areaList.map(({ stations }) => `<div class="stations-grid">${stations.map(([s, rows]) => cardFor(s, rows)).join('')}</div>`).join('');

  const floaterChips = floaters.map((r) => `<button class="chip chip-floater chip-link" data-search="${escapeHtml(`${r.staff_name} ${r.station}`.toLowerCase())}" data-name="${escapeHtml(r.staff_name)}" title="${escapeHtml(r.station)}">${escapeHtml(r.staff_name)}</button>`).join('');

  const canPrev = effectiveIdx > 0;
  const canNext = effectiveIdx < daySlots.length - 1;

  const allOpen = multiArea && areaList.every((a) => openAreas.has(a.area));

  container.innerHTML = `
    <div class="whos-sticky">
      <div class="slot-nav">
        <button class="nav-btn" data-dir="-1" aria-label="Previous time slot" ${canPrev ? '' : 'disabled'}>‹</button>
        <div class="slot-label">${fmt12(slot.start)}–${fmt12(slot.end)}</div>
        <button class="nav-btn" data-dir="1" aria-label="Next time slot" ${canNext ? '' : 'disabled'}>›</button>
      </div>
      <div class="whos-tools">
        <input type="search" class="whos-search" id="whos-search" placeholder="Filter by area, station or person…" value="${escapeHtml(whosFilter)}" autocomplete="off" aria-label="Filter stations">
        ${multiArea ? `<button class="areas-toggle">${allOpen ? 'Collapse all' : 'Expand all'}</button>` : ''}
      </div>
    </div>
    <div class="whos-areas">${areaBlocks || '<p class="hint">No one staffed at this time.</p>'}</div>
    <p class="hint whos-noresults" hidden>No stations match that filter.</p>
    ${multiArea ? '' : `<div class="floater-panel">
      <div class="floater-panel-title">On backup (${floaters.length})</div>
      <div class="floater-chips">${floaterChips || '<span class="hint">No floaters scheduled this slot.</span>'}</div>
    </div>`}`;

  const applyFilter = () => {
    const q = whosFilter.trim().toLowerCase();
    container.querySelectorAll('[data-search]').forEach((el) => {
      el.hidden = !!q && !el.dataset.search.includes(q);
    });
    // While filtering, open every area with a match; otherwise restore the
    // user's own open/closed choices.
    container.querySelectorAll('details.area').forEach((d) => {
      const any = [...d.querySelectorAll('.area-row')].some((r) => !r.hidden);
      d.hidden = !!q && !any;
      const want = q ? any : openAreas.has(d.dataset.area);
      // Mark programmatic changes: the async `toggle` event must not record them
      // as the user's choice.
      if (d.open !== want) { d.dataset.prog = String(want); d.open = want; }
    });
    const noResults = container.querySelector('.whos-noresults');
    if (noResults) {
      const anyMatch = [...container.querySelectorAll('.station-card, .area-row')].some((c) => !c.hidden);
      noResults.hidden = !(q && !anyMatch);
    }
  };
  const searchEl = container.querySelector('#whos-search');
  if (searchEl) searchEl.addEventListener('input', () => { whosFilter = searchEl.value; applyFilter(); });
  applyFilter();

  const areasToggle = container.querySelector('.areas-toggle');
  const allAreasOpen = () => areaList.every((a) => openAreas.has(a.area));
  const syncToggleLabel = () => { if (areasToggle) areasToggle.textContent = allAreasOpen() ? 'Collapse all' : 'Expand all'; };

  container.querySelectorAll('details.area').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (d.dataset.prog === String(d.open)) { delete d.dataset.prog; return; }
      delete d.dataset.prog;
      if (d.open) openAreas.add(d.dataset.area); else openAreas.delete(d.dataset.area);
      syncToggleLabel();
    });
  });
  if (areasToggle) {
    areasToggle.addEventListener('click', () => {
      openAreas = new Set(allAreasOpen() ? [] : areaList.map((a) => a.area));
      whosFilter = '';
      searchEl.value = '';
      applyFilter();
      syncToggleLabel();
    });
  }

  container.querySelectorAll('.nav-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      renderWhosOnNow(container, data, dayName, effectiveIdx + parseInt(btn.dataset.dir, 10), onSelectPerson, event);
    });
  });

  if (onSelectPerson) {
    container.querySelectorAll('.chip-link').forEach((btn) => {
      btn.addEventListener('click', () => onSelectPerson(btn.dataset.name));
    });
  }

  return { slot, effectiveIdx, daySlots };
}
