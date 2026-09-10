-- Staff-initiated shift-change requests. A request is a proposal only; it
-- never mutates the schedule until an admin approves it (which applies a
-- drift-guarded cover_shift). Separate table so requests don't touch shifts.
CREATE TABLE IF NOT EXISTS change_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  shift_id       INTEGER,
  day            TEXT,
  station        TEXT,
  start_time     TEXT,          -- the FULL shift's times (snapshot at filing)
  end_time       TEXT,
  requested_start TEXT,         -- the sub-window to hand off (defaults to full shift)
  requested_end   TEXT,
  target_name    TEXT,          -- null = open "anyone cover?" ask
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | declined
  coverer_name   TEXT,          -- who took it, set on approve
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_event_status ON change_requests(event_id, status);
