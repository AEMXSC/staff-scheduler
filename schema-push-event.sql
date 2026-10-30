-- Set only on devices signed up for "your shifts changed" alerts, so an admin
-- change at one event never pings someone's device from another event.
ALTER TABLE push_subscriptions ADD COLUMN event_id TEXT;
