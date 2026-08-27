-- Web Push subscriptions for admins (Geneliz) who opted into phone alerts.
-- endpoint is the unique push-service URL; keys are stored for future payload
-- encryption (current alerts are payload-less "tickle" pushes).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT,
  auth        TEXT,
  created_at  TEXT NOT NULL,
  staff_name  TEXT              -- NULL = admin (broadcast); set = that person's device
);
