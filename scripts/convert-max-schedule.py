"""Convert the MAX "Staff Tracker & Booth Schedule" xlsx (one tab per area,
day/time rows x demo-station columns) into the flat schedule schema the app reads.

Usage: python convert-max-schedule.py <input.xlsx> <output.json>
"""
import datetime
import difflib
import json
import re
import sys

import openpyxl

ROSTER_TAB = "Adobe Booth Approved Staff"
DAY_DATES = {"Tuesday": "2026-11-10", "Wednesday": "2026-11-11", "Thursday": "2026-11-12"}
SLOT_MINUTES = 30
NOT_A_PERSON = {"-", "break", "lunch", "demo", "demo prep", "demo presentation",
                "community expert", "community expert?", "float", "on", "?"}
ALIASES = {"Jusin Patton": "Justin Patton"}


def norm(s):
    return re.sub(r"\s+", " ", str(s).replace("\xa0", " ").replace("​", "")).strip()


def load_roster(wb):
    ws = wb[ROSTER_TAB]
    people = []
    for r in ws.iter_rows(min_row=3, values_only=True):
        area, first, last = (norm(v) if v else "" for v in r[1:4])
        if first and last:
            people.append({"area": area, "first": first, "full": f"{first} {last}"})
    return people


def area_matches(roster_area, tab):
    if not roster_area:
        return False
    a, t = roster_area.lower(), tab.lower()
    return t in a or a.replace("adobe ", "") in t


class Resolver:
    def __init__(self, roster):
        self.roster = roster
        self.full_names = {p["full"].lower(): p["full"] for p in roster}
        self.log = {}

    def resolve(self, raw, tab, tab_full_names):
        name = ALIASES.get(raw, raw)
        if name.lower() in self.full_names:
            return self.full_names[name.lower()]
        in_area = [p for p in self.roster if area_matches(p["area"], tab)]
        if " " not in name:
            in_tab = [{"first": n.split(" ")[0], "full": n} for n in tab_full_names]
            for pool in (in_tab, in_area, self.roster):
                hits = {p["full"] for p in pool if p["first"].lower() == name.lower()}
                if len(hits) == 1:
                    full = hits.pop()
                    return self._note(raw, self.resolve(full, tab, ()) if pool is in_tab else full, tab)
            hits = {p["full"] for p in in_area if p["first"].lower().startswith(name.lower())}
            if len(hits) == 1:
                return self._note(raw, hits.pop(), tab)
            return self._note(raw, name, tab, unresolved=True)
        for pool in (in_area, self.roster):
            close = difflib.get_close_matches(name, [p["full"] for p in pool], n=1, cutoff=0.85)
            if close:
                return self._note(raw, close[0], tab)
        return self._note(raw, name, tab, unresolved=True)

    def _note(self, raw, out, tab, unresolved=False):
        if raw != out or unresolved:
            self.log[(tab, raw)] = (out, unresolved)
        return out


def split_people(cell):
    """'A, B' / 'A + B' / 'A & B' / 'A / B' / 'A and B' / multi-line -> ['A','B'];
    drops '- Expert' / '-Community' / '- Express Ambassador' role tags and
    break/lunch/role notes. Split happens before
    norm() so newlines still separate people."""
    out, skipped = [], []
    for part in re.split(r"[\n,/&+]| and ", str(cell)):
        raw = norm(part)
        p = re.sub(r"\s*-?\s*\b(Expert|Community|Express Ambassador)$", "", raw, flags=re.I)
        if not p:
            continue
        if raw.lower() in NOT_A_PERSON or p.lower() in NOT_A_PERSON or "(" in p or ":" in p or re.search(r"\b(break|lunch)\b", p, re.I):
            skipped.append(p)
            continue
        out.append(p)
    return list(dict.fromkeys(out)), skipped


def station_columns(ws):
    """Header cells from column C up to and including FLOATER (or the first gap)."""
    cols = {}
    for cell in ws[header_row(ws)][2:]:
        h = norm(cell.value) if cell.value else ""
        if not h:
            break
        cols[cell.column] = h
        if h.upper() == "FLOATER":
            break
    return cols


def label(header):
    h = header.title() if header.isupper() or header.upper().startswith("DEMO") else header
    return re.sub(r"\bAbi\b", "ABI", re.sub(r"\bFfcpe\b", "FFCPE", h))


def header_row(ws):
    """The DAY/TIME/DEMO header is row 2 on most tabs, lower on some (Lightroom)."""
    for i, r in enumerate(ws.iter_rows(min_row=1, max_row=6, max_col=1, values_only=True), 1):
        if r[0] and norm(r[0]).upper() == "DAY":
            return i
    return 2


def read_slots(ws, tab, warnings):
    rows = []
    for r in ws.iter_rows(min_row=header_row(ws) + 1, values_only=True):
        day, t = (norm(r[0]) if r[0] else ""), r[1]
        if isinstance(t, str) and re.fullmatch(r"\d{1,2}:\d\d(:\d\d)?", t.strip()):
            t = datetime.time.fromisoformat(t.strip().zfill(8 if t.count(":") == 2 else 5))
        if day in DAY_DATES and isinstance(t, datetime.time):
            rows.append([day, t, r])
    for i in range(1, len(rows) - 1):
        prev, cur, nxt = rows[i - 1], rows[i], rows[i + 1]
        if cur[0] != prev[0] and nxt[0] == cur[0] and nxt[1] < cur[1]:
            warnings.append(f"{tab}: row '{cur[0]} {cur[1]:%H:%M}' treated as {prev[0]} (out of sequence)")
            cur[0] = prev[0]
    return rows


def add_minutes(t, m):
    return (datetime.datetime.combine(datetime.date(2000, 1, 1), t) + datetime.timedelta(minutes=m)).strftime("%H:%M")


# --- Tabs laid out as time blocks rather than the half-hour grid ---
RANGE = re.compile(r"(\d{1,2})(?::(\d\d))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d\d))?\s*(am|pm)", re.I)


def parse_range(text):
    """'10:30-12:15pm' / '11:00 AM – 2:15 PM' -> ('10:30', '12:15'); None if no range."""
    m = RANGE.search(text or "")
    if not m:
        return None
    h1, m1, s1, h2, m2, s2 = m.groups()
    to24 = lambda h, s: int(h) % 12 + (12 if s.lower() == "pm" else 0)
    end = (to24(h2, s2), int(m2 or 0))
    start = (to24(h1, s1 or s2), int(m1 or 0))
    if not s1 and start > end:  # '10:30-12:15pm' starts in the morning
        start = (to24(h1, "am"), start[1])
    return f"{start[0]:02d}:{start[1]:02d}", f"{end[0]:02d}:{end[1]:02d}"


def day_of(text):
    return next((d for d in DAY_DATES if d.lower() in (text or "").lower()), None)


def block_cell(val, start, end):
    """Names in one block cell, with the block's times unless the cell gives its own
    '(5:30pm-8pm)'. Other parenthetical notes are dropped; 'Optional:' is skipped."""
    text = norm(val)
    if not text or text.startswith('"') or text.lower().startswith("optional"):
        return [], [text] if text else []
    own = re.search(r"\(([^)]*)\)", text)
    if own and parse_range(own.group(1)):
        start, end = parse_range(own.group(1))
    people, skipped = split_people(re.sub(r"\s*\([^)]*\)", "", text))
    return [(p, start, end) for p in people], skipped


def firefly_blocks(ws):
    """Day headers ('Tuesday, 11/10') above columns of time blocks ('10:30-12:15pm'),
    names listed under each block. Notes in quotes and the left-hand roster are ignored."""
    days, out = {}, []
    for row in ws.iter_rows(min_row=1, max_row=12):
        for c in row:
            if isinstance(c.value, str) and day_of(c.value) and re.search(r"\d+/\d+", c.value):
                days[c.column] = day_of(c.value)
    for row in ws.iter_rows(min_row=1, max_row=12):
        for c in row:
            v = norm(c.value) if isinstance(c.value, str) else ""
            if not (v and RANGE.fullmatch(v) and c.column >= min(days, default=99)):
                continue
            day = days[max(col for col in days if col <= c.column)]
            start, end = parse_range(v)
            for below in ws.iter_rows(min_row=c.row + 1, max_row=ws.max_row, min_col=c.column, max_col=c.column):
                out.append((day, below[0].value, start, end, "Booth"))
    return out


def ce_blocks(ws):
    """Product columns (Photoshop, Lightroom, ...) across, shift rows down
    ('11:00 AM – 2:15 PM | 3H'), each day introduced by a 'Tuesday, November 10th' row."""
    out, day, header = [], None, {}
    for i, r in enumerate(ws.iter_rows(values_only=True), 1):
        a = norm(r[0]) if r[0] else ""
        if i == 1 or (not a and r[1]):
            header = {j: norm(v) for j, v in enumerate(r) if j and v}
        elif day_of(a) and not RANGE.search(a):
            day = day_of(a)
        elif day and "|" in a and "lunch" not in a.lower() and parse_range(a):
            start, end = parse_range(a)
            out += [(day, r[j], start, end, product) for j, product in header.items() if j < len(r)]
    return out


BLOCK_TABS = {"Firefly": ("Firefly", firefly_blocks),
              "Community Experts (non-Adobe)": ("Community Experts", ce_blocks)}


def convert_blocks(ws, area, reader, resolver, skipped_notes):
    cells = []  # (day, raw name, start, end, station)
    for day, val, start, end, station in reader(ws):
        if val is None:
            continue
        people, skipped = block_cell(val, start, end)
        cells += [(day, p, s, e, station) for p, s, e in people]
        for s in skipped:
            skipped_notes[s] = skipped_notes.get(s, 0) + 1
    full = {p for _, p, *_ in cells if " " in p}
    rows = []
    for day, raw, start, end, station in sorted(cells, key=lambda c: (c[0], c[2])):
        person = resolver.resolve(raw, area, full)
        prev = next((x for x in rows if x["staff_name"] == person and x["day"] == day
                     and x["station"].endswith(station) and x["end_time"] == start), None)
        if prev:
            prev["end_time"] = end
        else:
            rows.append({"staff_name": person, "day": day, "date": DAY_DATES[day], "start_time": start,
                         "end_time": end, "station": f"{area} · {station}", "is_floater": False, "group": area})
    return rows


def already_in_product_area(expert, rows):
    """Community Experts lists many people the product grids already schedule
    ('Julie Bonner - Community' on Express). Same person, overlapping time, area
    named for the product ('Fresco' -> 'PrM x Fresco') means the same stint."""
    product = expert["station"].split(" · ")[1].split()[0].lower()
    return any(r["staff_name"] == expert["staff_name"] and r["date"] == expert["date"]
               and product in r["group"].lower() and r["group"] != expert["group"]
               and r["start_time"] < expert["end_time"] and expert["start_time"] < r["end_time"]
               for r in rows)


def convert(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    resolver = Resolver(load_roster(wb))
    warnings, skipped_notes, out, experts = [], {}, [], []

    for ws in wb.worksheets:
        if ws.title == ROSTER_TAB:
            continue
        tab = norm(ws.title)
        if tab in BLOCK_TABS:
            area, reader = BLOCK_TABS[tab]
            (experts if area == "Community Experts" else out).extend(
                convert_blocks(ws, area, reader, resolver, skipped_notes))
            continue
        cols = station_columns(ws)
        slots = read_slots(ws, tab, warnings)
        tab_full_names = {p for _, _, r in slots for col in cols
                          if col - 1 < len(r) and isinstance(r[col - 1], str)
                          for p in split_people(r[col - 1])[0] if " " in p}
        runs = {}  # (person, station) -> open run
        for day, t, r in slots:
            seen_now = set()
            for col, header in cols.items():
                val = r[col - 1] if col - 1 < len(r) else None
                if not isinstance(val, str) or not norm(val):
                    continue
                people, skipped = split_people(val)
                for s in skipped:
                    skipped_notes[s] = skipped_notes.get(s, 0) + 1
                station = f"{tab} · {label(header)}"
                for raw in people:
                    person = resolver.resolve(raw, tab, tab_full_names)
                    seen_now.add((person, station))
                    key = (person, station)
                    run = runs.get(key)
                    start = t.strftime("%H:%M")
                    if run and run["day"] == day and run["end_time"] == start:
                        run["end_time"] = add_minutes(t, SLOT_MINUTES)
                    else:
                        if run:
                            out.append(run)
                        runs[key] = {"staff_name": person, "day": day, "date": DAY_DATES[day],
                                     "start_time": start, "end_time": add_minutes(t, SLOT_MINUTES),
                                     "station": station, "is_floater": header.upper() == "FLOATER",
                                     "group": tab}
        out.extend(runs.values())

    dupes = [e for e in experts if already_in_product_area(e, out)]
    warnings += [f"Community Experts: {e['staff_name']} {e['day']} {e['start_time']}-{e['end_time']} "
                 f"{e['station'].split(' · ')[1]} already on that product's grid, not added again" for e in dupes]
    out.extend(e for e in experts if e not in dupes)
    out.sort(key=lambda s: (s["date"], s["group"], s["station"], s["start_time"], s["staff_name"]))
    return out, warnings, resolver.log, skipped_notes


def double_bookings(rows):
    by_person = {}
    for r in rows:
        by_person.setdefault((r["staff_name"], r["date"]), []).append(r)
    clashes = []
    for (name, date), shifts in by_person.items():
        shifts.sort(key=lambda s: s["start_time"])
        latest = shifts[0]  # shift with the furthest end so far, so non-adjacent overlaps count too
        for b in shifts[1:]:
            if b["start_time"] < latest["end_time"]:
                clashes.append(f"{name} {date}: {latest['station']} {latest['start_time']}-{latest['end_time']} "
                               f"overlaps {b['station']} {b['start_time']}-{b['end_time']}")
            if b["end_time"] > latest["end_time"]:
                latest = b
    return clashes


if __name__ == "__main__":
    in_path, out_path = sys.argv[1], sys.argv[2]
    rows, warnings, name_log, skipped = convert(in_path)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(rows)} shifts, {len({r['staff_name'] for r in rows})} people, "
          f"{len({r['station'] for r in rows})} stations, {len({r['group'] for r in rows})} areas -> {out_path}")
    for w in warnings:
        print("WARNING:", w)
    print("\nNAME RESOLUTIONS:")
    for (tab, raw), (out, unresolved) in sorted(name_log.items()):
        print(f"  [{tab}] {raw!r} -> {out!r}" + ("   (UNRESOLVED, kept as-is)" if unresolved else ""))
    print("\nSKIPPED CELL TEXT (not shifts):")
    for s, n in sorted(skipped.items()):
        print(f"  {n:3d} x {s!r}")
    clashes = double_bookings(rows)
    print(f"\nDOUBLE BOOKINGS: {len(clashes)}")
    for c in clashes:
        print("  " + c)
