"""Sync MAX from the master sheet: convert shifts and the All Staff contacts,
show what changes against the live site, and (with --apply) load both into D1.

Usage:
  powershell -File scripts/fetch-max-sheet.ps1 -Out <dir>/max.xlsx
  python scripts/sync-max.py <dir>/max.xlsx            # dry run: diff only
  python scripts/sync-max.py <dir>/max.xlsx --apply    # load into live D1

Loading replaces every MAX shift and contact, so admin-agent edits that aren't
in the sheet are lost; the dry run lists them under "removed".
"""
import collections
import difflib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

import openpyxl

EVENT = "max-2026"
LIVE = "https://max.adobeschedule.com"
HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("conv", os.path.join(HERE, "convert-max-schedule.py"))
conv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(conv)


def phone(v):
    if v in (None, ""):
        return None
    d = re.sub(r"\D", "", conv.norm(v).split(".")[0])
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    if len(d) == 10:
        return f"({d[:3]}) {d[3:6]}-{d[6:]}"
    return f"+{d}" if len(d) > 10 else (conv.norm(v) or None)


def contacts(path, scheduled):
    """All Staff tab -> one contact per person, named as the schedule names them."""
    ws = openpyxl.load_workbook(path, data_only=True)["All Staff"]
    rows = [r for r in ws.iter_rows(min_row=2, values_only=True)]
    full = lambda r: f"{conv.norm(r[0] or '')} {conv.norm(r[1] or '')}".strip()
    email = lambda r: conv.norm(r[2] or "").lower()
    emails = collections.defaultdict(set)
    for r in rows:
        emails[full(r)].add(email(r))
    people = {}
    for r in rows:
        name = full(r)
        if not name:
            continue
        if name not in scheduled:
            # Spelling fixes ('Joely' -> 'Joey') only onto someone with no row of
            # their own or the same email: 'Pavan' and 'Pawan Kumar' are two people.
            close = difflib.get_close_matches(name, sorted(scheduled), n=1, cutoff=0.88)
            if close and (close[0] not in emails or email(r) in emails[close[0]]):
                name = close[0]
        p = people.setdefault(name, {"name": name, "email": None, "phone": None})
        p["email"] = p["email"] or (conv.norm(r[2] or "") or None)
        p["phone"] = p["phone"] or phone(r[3])
    return sorted(people.values(), key=lambda p: p["name"])


def live(path):
    req = urllib.request.Request(LIVE + path, headers={"User-Agent": "Mozilla/5.0 (sync-max)"})
    with urllib.request.urlopen(req) as res:
        return json.load(res)


def q(v):
    return "NULL" if v in (None, "") else "'" + str(v).replace("'", "''") + "'"


def sql(shifts, people):
    lines = [f"DELETE FROM shifts WHERE event_id = {q(EVENT)};"]
    lines += [f"INSERT INTO shifts (event_id, staff_name, day, date, start_time, end_time, station, is_floater, group_name) "
              f"VALUES ({q(EVENT)}, {q(r['staff_name'])}, {q(r['day'])}, {q(r['date'])}, {q(r['start_time'])}, "
              f"{q(r['end_time'])}, {q(r['station'])}, {1 if r['is_floater'] else 0}, {q(r['group'])});" for r in shifts]
    lines.append(f"DELETE FROM contacts WHERE event_id = {q(EVENT)};")
    lines += [f"INSERT INTO contacts (event_id, name, email, phone) VALUES ({q(EVENT)}, {q(p['name'])}, {q(p['email'])}, {q(p['phone'])});"
              for p in people]
    return "\n".join(lines) + "\n"


def shift_key(r):
    return (r["staff_name"], r["day"], r["start_time"], r["end_time"], r["station"], bool(r["is_floater"]),
            r.get("group") or r.get("group_name"))


def main():
    path, apply = sys.argv[1], "--apply" in sys.argv
    shifts, warnings, names, _ = conv.convert(path)
    people = contacts(path, {r["staff_name"] for r in shifts})
    print(f"Sheet: {len(shifts)} shifts, {len({r['staff_name'] for r in shifts})} people, "
          f"{len({r['group'] for r in shifts})} areas, {len(people)} contacts")
    for w in warnings:
        if "already on that" not in w:
            print("WARNING:", w)
    unresolved = sorted({raw for (_, raw), (_, bad) in names.items() if bad})
    if unresolved:
        print("Not on the staff list (shown as typed):", ", ".join(unresolved))

    new, old = collections.Counter(map(shift_key, shifts)), collections.Counter(map(shift_key, live(f"/api/schedule/{EVENT}")))
    added, removed = new - old, old - new
    print(f"\nShifts vs live: +{sum(added.values())} -{sum(removed.values())}")
    for label, c in (("+", added), ("-", removed)):
        by_area = collections.Counter(k[6] for k in c.elements())
        if by_area:
            print(f"  {label} by area:", dict(by_area.most_common()))
    cnew = {(p["name"], p["email"], p["phone"]) for p in people}
    cold = {(p["name"], p["email"], p["phone"]) for p in live(f"/api/directory/{EVENT}")}
    print(f"Contacts vs live: +{len(cnew - cold)} -{len(cold - cnew)}")

    if not (added or removed or cnew != cold):
        print("\nLive already matches the sheet.")
        return
    out = os.path.splitext(path)[0] + "-load.sql"
    with open(out, "w", encoding="utf-8") as f:
        f.write(sql(shifts, people))
    if not apply:
        print(f"\nDry run. Load with --apply (SQL at {out}).")
        return
    # No shell: sheet paths can contain '&'. which() finds npx.cmd on Windows.
    subprocess.run([shutil.which("npx"), "wrangler", "d1", "execute", "staff-scheduler-db", "--remote", "--file", out, "-y"],
                   check=True, cwd=os.path.dirname(HERE), stdout=subprocess.DEVNULL)
    ok = collections.Counter(map(shift_key, live(f"/api/schedule/{EVENT}"))) == new
    okc = {(p["name"], p["email"], p["phone"]) for p in live(f"/api/directory/{EVENT}")} == cnew
    print(f"\nLoaded. Live shifts match sheet: {ok}. Live contacts match sheet: {okc}.")
    sys.exit(0 if ok and okc else 1)


if __name__ == "__main__":
    main()
