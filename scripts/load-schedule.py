"""Convert an IBC grid xlsx and emit SQL to reload one event's rows into D1.

Usage:
  python scripts/load-schedule.py <input.xlsx> <event_id> > seed.sql
  npx wrangler d1 execute staff-scheduler-db --remote --file seed.sql

Emits a DELETE for the event followed by INSERTs, so re-running fully
replaces that event's schedule (idempotent per event).
"""
import sys
import importlib.util
import os

_spec = importlib.util.spec_from_file_location(
    "convert_ibc_schedule",
    os.path.join(os.path.dirname(__file__), "convert-ibc-schedule.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
convert = _mod.convert


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def main():
    in_path, event_id = sys.argv[1], sys.argv[2]
    rows, warnings = convert(in_path)
    for w in warnings:
        print(f"-- WARNING: {w}", file=sys.stderr)

    # No explicit BEGIN/COMMIT -- D1 wraps a --file batch in its own
    # transaction and rejects manual transaction statements.
    print(f"DELETE FROM shifts WHERE event_id = {sql_str(event_id)};")
    for r in rows:
        cols = (sql_str(event_id), sql_str(r["staff_name"]), sql_str(r["day"]),
                sql_str(r["date"]), sql_str(r["start_time"]), sql_str(r["end_time"]),
                sql_str(r["station"]), "1" if r["is_floater"] else "0", sql_str(r.get("group")))
        print("INSERT INTO shifts (event_id, staff_name, day, date, start_time, "
              "end_time, station, is_floater, group_name) VALUES (" + ", ".join(cols) + ");")
    print(f"-- {len(rows)} rows for event {event_id}", file=sys.stderr)


if __name__ == "__main__":
    main()
