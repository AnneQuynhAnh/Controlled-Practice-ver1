-- Teacher-configurable Controlled Practice settings (single row).
CREATE TABLE cp_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  items_per_test              INTEGER NOT NULL DEFAULT 10 CHECK (items_per_test BETWEEN 1 AND 30),
  daily_guided_review_limit   INTEGER NOT NULL DEFAULT 5 CHECK (daily_guided_review_limit BETWEEN 1 AND 20),
  daily_delayed_review_cap    INTEGER NOT NULL DEFAULT 5 CHECK (daily_delayed_review_cap BETWEEN 1 AND 20),
  min_sources_per_test        INTEGER NOT NULL DEFAULT 8 CHECK (min_sources_per_test BETWEEN 1 AND 30),
  updated_at                  INTEGER NOT NULL
);
INSERT INTO cp_settings (id, updated_at) VALUES (1, 0);
