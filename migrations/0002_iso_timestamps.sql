-- CAD Babel 0002: one timestamp format everywhere, and one SetupIntent per reservation.
--
-- 0001 defaulted both `created_at` columns to datetime('now'), which writes
-- `2026-09-17 23:43:15` — no T, no Z, and not textually comparable with the
-- ISO-8601 instants the Worker writes into `disclosure_shown_at`. Two formats in
-- the same row make the obvious audit query ("was the disclosure shown before
-- the row was written?") and any `?since=` window return nonsense. SQLite cannot
-- alter a column default, so each table is rebuilt; both databases hold almost
-- no rows and there is no backwards-compatibility requirement.
--
-- Every statement must be terminated with a semicolon and must not contain one
-- inside a string literal: the test harness replays this file statement by
-- statement.

UPDATE events SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at) WHERE created_at NOT LIKE '%Z';

UPDATE reservations SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at) WHERE created_at NOT LIKE '%Z';

CREATE TABLE events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  direction TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (kind IN ('page_view', 'door_select')),
  CHECK (direction IN ('sw-to-fusion', 'fusion-to-sw') OR direction IS NULL)
);

INSERT INTO events_v2 (id, kind, direction, created_at) SELECT id, kind, direction, created_at FROM events;

DROP TABLE events;

ALTER TABLE events_v2 RENAME TO events;

CREATE INDEX events_kind_direction_idx ON events (kind, direction);

CREATE TABLE reservations_v2 (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  direction TEXT NOT NULL,
  purpose TEXT NOT NULL,
  needed_by TEXT,
  disclosure_shown_at TEXT NOT NULL,
  disclosure_ack INTEGER NOT NULL,
  stripe_customer_id TEXT,
  stripe_setup_intent_id TEXT,
  card_on_file INTEGER NOT NULL DEFAULT 0,
  -- The founder records the written second confirmation out of band; the API
  -- only ever reads this column and never writes 'yes'.
  second_yes TEXT NOT NULL DEFAULT 'no-reply',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (direction IN ('sw-to-fusion', 'fusion-to-sw')),
  CHECK (purpose IN ('client-deliverable', 'product', 'hobby')),
  CHECK (disclosure_ack IN (0, 1)),
  CHECK (card_on_file IN (0, 1)),
  CHECK (second_yes IN ('yes', 'no', 'no-reply'))
);

INSERT INTO reservations_v2 (id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack, stripe_customer_id, stripe_setup_intent_id, card_on_file, second_yes, created_at) SELECT id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack, stripe_customer_id, stripe_setup_intent_id, card_on_file, second_yes, created_at FROM reservations;

DROP TABLE reservations;

ALTER TABLE reservations_v2 RENAME TO reservations;

CREATE UNIQUE INDEX reservations_email_idx ON reservations (email);

CREATE INDEX reservations_direction_idx ON reservations (direction);

-- Defence in depth for the invariant handleReserveConfirm relies on: one
-- SetupIntent belongs to exactly one reservation. SQLite treats NULLs as
-- distinct, so rows that have not reached Stripe yet are unaffected.
CREATE UNIQUE INDEX reservations_setup_intent_idx ON reservations (stripe_setup_intent_id);
