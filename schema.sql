-- Schedule rows. `id` is a stable per-row key so admin edits target exact
-- rows (a person can have more than one shift on a day). event_id namespaces
-- multiple events in one table.
DROP TABLE IF EXISTS shifts;
CREATE TABLE shifts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL,
  staff_name  TEXT NOT NULL,
  day         TEXT NOT NULL,
  date        TEXT,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  station     TEXT NOT NULL,
  is_floater  INTEGER NOT NULL DEFAULT 0,
  group_name  TEXT
);
CREATE INDEX idx_shifts_event ON shifts(event_id);
CREATE INDEX idx_shifts_event_day ON shifts(event_id, day);
CREATE INDEX idx_shifts_event_name ON shifts(event_id, staff_name);
