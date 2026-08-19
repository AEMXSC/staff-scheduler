import {
  getZonedNow, toMins, fmt12, escapeHtml,
} from './time-utils.js';

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

      return `<div class="slot${isActive ? ' slot-active' : ''}${slot.is_floater ? ' slot-floater' : ''}">
        <div class="slot-top">
          <span class="slot-station">${escapeHtml(slot.station)}</span>
          <span class="slot-time">${fmt12(slot.start_time)}–${fmt12(slot.end_time)}</span>
          ${isActive ? '<span class="now-badge">NOW</span>' : ''}
        </div>
        ${slot.is_floater ? '<div class="floater-label">Backup / floater</div>' : ''}
        <button class="slot-request-btn" data-idx="${idx}">Request change</button>
      </div>`;
    }).join('');

    return `<div class="day-card${isToday ? ' day-today' : ''}">
      <div class="day-heading">
        <span class="day-name">${day}</span>
        ${isToday ? '<span class="today-pill">Today</span>' : ''}
      </div>
      <div class="slots">${slotItems}</div>
    </div>`;
  }).filter(Boolean).join('');

  container.innerHTML = dayCards || '<p class="hint">No slots across any event day.</p>';

  if (onRequestChange) {
    container.querySelectorAll('.slot-request-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRequestChange(renderedSlots[Number(btn.dataset.idx)]));
    });
  }
}

export function renderWhosOnNow(container, data, dayName, slotIdx, onSelectPerson) {
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

  const byStation = new Map();
  primaries.forEach((r) => {
    if (!byStation.has(r.station)) byStation.set(r.station, []);
    byStation.get(r.station).push(r);
  });

  const stationCards = [...byStation.entries()].sort(([a], [b]) => a.localeCompare(b)).map(
    ([station, rows]) => `<div class="station-card">
      <div class="station-name">${escapeHtml(station)}</div>
      <div class="station-people">${rows.map((r) => `<button class="chip chip-link" data-name="${escapeHtml(r.staff_name)}">${escapeHtml(r.staff_name)}</button>`).join('')}</div>
    </div>`,
  ).join('');

  const floaterChips = floaters.map((r) => `<button class="chip chip-floater chip-link" data-name="${escapeHtml(r.staff_name)}" title="${escapeHtml(r.station)}">${escapeHtml(r.staff_name)}</button>`).join('');

  const canPrev = effectiveIdx > 0;
  const canNext = effectiveIdx < daySlots.length - 1;

  container.innerHTML = `
    <div class="slot-nav">
      <button class="nav-btn" data-dir="-1" aria-label="Previous time slot" ${canPrev ? '' : 'disabled'}>‹</button>
      <div class="slot-label">${fmt12(slot.start)}–${fmt12(slot.end)}</div>
      <button class="nav-btn" data-dir="1" aria-label="Next time slot" ${canNext ? '' : 'disabled'}>›</button>
    </div>
    <div class="stations-grid">${stationCards || '<p class="hint">No one staffed at this time.</p>'}</div>
    <div class="floater-panel">
      <div class="floater-panel-title">On backup (${floaters.length})</div>
      <div class="floater-chips">${floaterChips || '<span class="hint">No floaters scheduled this slot.</span>'}</div>
    </div>`;

  container.querySelectorAll('.nav-btn:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      renderWhosOnNow(container, data, dayName, effectiveIdx + parseInt(btn.dataset.dir, 10), onSelectPerson);
    });
  });

  if (onSelectPerson) {
    container.querySelectorAll('.chip-link').forEach((btn) => {
      btn.addEventListener('click', () => onSelectPerson(btn.dataset.name));
    });
  }

  return { slot, effectiveIdx, daySlots };
}
