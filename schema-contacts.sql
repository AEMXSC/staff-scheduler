-- Staff directory (names + contact channels). Separate from shifts so a
-- contacts re-upload never touches the schedule and vice-versa. Holds PII
-- (phone/email) -- served only behind the admin gate.
CREATE TABLE IF NOT EXISTS contacts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT NOT NULL,
  name      TEXT NOT NULL,
  email     TEXT,
  phone     TEXT,
  slack     TEXT,
  whatsapp  TEXT,
  title     TEXT,
  manager   TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_event ON contacts(event_id);
