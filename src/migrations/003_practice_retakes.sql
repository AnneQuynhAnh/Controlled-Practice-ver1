-- Practice retakes and free practice of previously missed sentences.
-- The original independent attempt stays unique and immutable; practice attempts are numbered after it.

CREATE TABLE assessment_attempts_new (
  id                 INTEGER PRIMARY KEY,
  test_id            INTEGER NOT NULL REFERENCES tests(id),
  student_id         INTEGER NOT NULL REFERENCES users(id),
  attempt_kind       TEXT NOT NULL DEFAULT 'independent' CHECK (attempt_kind IN ('independent', 'practice')),
  attempt_no         INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  current_position   INTEGER NOT NULL DEFAULT 1,
  item_count         INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  started_after_due  INTEGER NOT NULL DEFAULT 0,
  submitted_at       INTEGER,
  active_ms          INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at  INTEGER,
  UNIQUE (test_id, student_id, attempt_no)
);
INSERT INTO assessment_attempts_new
  (id, test_id, student_id, attempt_kind, attempt_no, status, current_position, item_count, started_at, started_after_due, submitted_at, active_ms, last_heartbeat_at)
SELECT id, test_id, student_id, 'independent', 1, status, current_position, item_count, started_at, started_after_due, submitted_at, active_ms, last_heartbeat_at
  FROM assessment_attempts;
DROP TABLE assessment_attempts;
ALTER TABLE assessment_attempts_new RENAME TO assessment_attempts;
CREATE UNIQUE INDEX assessment_attempts_one_independent ON assessment_attempts (test_id, student_id) WHERE attempt_kind = 'independent';
CREATE UNIQUE INDEX assessment_attempts_one_open_practice ON assessment_attempts (test_id, student_id) WHERE attempt_kind = 'practice' AND status = 'in_progress';

-- Free practice checks on sentences already reviewed. Never changes review scheduling or scores.
CREATE TABLE review_practice (
  id              INTEGER PRIMARY KEY,
  review_item_id  INTEGER NOT NULL REFERENCES review_items(id),
  student_id      INTEGER NOT NULL REFERENCES users(id),
  answer_text     TEXT NOT NULL,
  word_accuracy   REAL NOT NULL,
  exact_match     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX review_practice_item ON review_practice (review_item_id);
