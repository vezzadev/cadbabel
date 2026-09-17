-- CAD Babel initial schema.
-- Applied with `wrangler d1 migrations apply` (see db:migrate:production / db:migrate:ppe).
-- Every statement must be terminated with a semicolon and must not contain one
-- inside a string literal: the test harness replays this file statement by statement.

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  direction TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (kind IN ('page_view', 'door_select')),
  CHECK (direction IN ('sw-to-fusion', 'fusion-to-sw') OR direction IS NULL)
);

CREATE INDEX events_kind_direction_idx ON events (kind, direction);

CREATE TABLE reservations (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (direction IN ('sw-to-fusion', 'fusion-to-sw')),
  CHECK (purpose IN ('client-deliverable', 'product', 'hobby')),
  CHECK (disclosure_ack IN (0, 1)),
  CHECK (card_on_file IN (0, 1)),
  CHECK (second_yes IN ('yes', 'no', 'no-reply'))
);

CREATE UNIQUE INDEX reservations_email_idx ON reservations (email);

CREATE INDEX reservations_direction_idx ON reservations (direction);
