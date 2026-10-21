-- Controlled Practice v1.0 schema.
-- All timestamps are INTEGER milliseconds since the Unix epoch (UTC).
-- Calendar logic (release days, "today") is computed in Asia/Ho_Chi_Minh by the server.

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  password_hash       TEXT NOT NULL,
  cp_paste_exception  INTEGER NOT NULL DEFAULT 0,   -- teacher-granted accessibility exception
  created_at          INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE audio_sources (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT '',
  rights_note        TEXT NOT NULL DEFAULT '',
  file_path          TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  duration_ms        INTEGER NOT NULL,
  transcript         TEXT NOT NULL DEFAULT '',
  created_by         INTEGER NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  archived_at        INTEGER
);

CREATE TABLE audio_segments (
  id                    INTEGER PRIMARY KEY,
  audio_id              INTEGER NOT NULL REFERENCES audio_sources(id),
  start_ms              INTEGER NOT NULL,
  end_ms                INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  transcript            TEXT NOT NULL DEFAULT '',
  topic                 TEXT NOT NULL DEFAULT '',
  difficulty            TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  main_skill_tag        TEXT NOT NULL CHECK (main_skill_tag IN ('word_recognition', 'speech_segmentation', 'connected_speech', 'information_processing')),
  secondary_skill_tags  TEXT NOT NULL DEFAULT '[]',
  familiarity_status    TEXT NOT NULL DEFAULT 'unseen' CHECK (familiarity_status IN ('previously_practised', 'unseen')),
  verification_status   TEXT NOT NULL DEFAULT 'draft' CHECK (verification_status IN ('draft', 'verified')),
  clip_path             TEXT,
  verified_by           INTEGER REFERENCES users(id),
  verified_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK (start_ms >= 0 AND end_ms > start_ms AND duration_ms = end_ms - start_ms)
);

CREATE TABLE schedule_plans (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  start_date  TEXT,                         -- YYYY-MM-DD in timezone
  timezone    TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE tests (
  id             INTEGER PRIMARY KEY,
  number         INTEGER NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily', 'final')),
  title          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'training' CHECK (mode IN ('recovery', 'training', 'transfer')),
  topic          TEXT NOT NULL DEFAULT '',
  situation      TEXT NOT NULL DEFAULT '',
  vocab_json     TEXT NOT NULL DEFAULT '[]',
  plan_day       INTEGER,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  release_at     INTEGER,
  due_at         INTEGER,
  shuffle_items  INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE test_items (
  id          INTEGER PRIMARY KEY,
  test_id     INTEGER NOT NULL REFERENCES tests(id),
  segment_id  INTEGER NOT NULL REFERENCES audio_segments(id),
  position    INTEGER NOT NULL,
  UNIQUE (test_id, segment_id)
);

CREATE TABLE student_assignments (
  id           INTEGER PRIMARY KEY,
  test_id      INTEGER NOT NULL REFERENCES tests(id),
  student_id   INTEGER NOT NULL REFERENCES users(id),
  release_at   INTEGER,                     -- per-student override, NULL = test default
  due_at       INTEGER,
  assigned_at  INTEGER NOT NULL,
  UNIQUE (test_id, student_id)
);

-- One active assessment session per student and scope (test attempt or review attempt).
CREATE TABLE cp_sessions (
  id            TEXT PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES users(id),
  scope_type    TEXT NOT NULL CHECK (scope_type IN ('test', 'review')),
  scope_id      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  ended_at      INTEGER,
  ended_reason  TEXT
);
CREATE INDEX cp_sessions_scope ON cp_sessions (student_id, scope_type, scope_id);

CREATE TABLE assessment_attempts (
  id                 INTEGER PRIMARY KEY,
  test_id            INTEGER NOT NULL REFERENCES tests(id),
  student_id         INTEGER NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  current_position   INTEGER NOT NULL DEFAULT 1,
  item_count         INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  started_after_due  INTEGER NOT NULL DEFAULT 0,
  submitted_at       INTEGER,
  active_ms          INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at  INTEGER,
  UNIQUE (test_id, student_id)
);

CREATE TABLE item_attempts (
  id                           INTEGER PRIMARY KEY,
  attempt_id                   INTEGER NOT NULL REFERENCES assessment_attempts(id),
  test_item_id                 INTEGER NOT NULL REFERENCES test_items(id),
  segment_id                   INTEGER NOT NULL REFERENCES audio_segments(id),
  position                     INTEGER NOT NULL,          -- frozen at attempt creation
  status                       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'submitted')),
  familiarity_at_start         TEXT NOT NULL CHECK (familiarity_at_start IN ('previously_practised', 'unseen')),
  draft_text                   TEXT NOT NULL DEFAULT '',
  draft_saved_at               INTEGER,
  opened_at                    INTEGER,
  submitted_at                 INTEGER,
  playback_start_count         INTEGER NOT NULL DEFAULT 0,
  playback_completed_count     INTEGER NOT NULL DEFAULT 0,
  playback_interruption_count  INTEGER NOT NULL DEFAULT 0,
  credits_restored             INTEGER NOT NULL DEFAULT 0,
  last_play_completed_at       INTEGER,
  UNIQUE (attempt_id, position),
  UNIQUE (attempt_id, test_item_id)
);

-- Original independent answers. Immutable once written (see triggers below).
CREATE TABLE submitted_answers (
  id               INTEGER PRIMARY KEY,
  item_attempt_id  INTEGER NOT NULL UNIQUE REFERENCES item_attempts(id),
  attempt_id       INTEGER NOT NULL REFERENCES assessment_attempts(id),
  student_id       INTEGER NOT NULL REFERENCES users(id),
  answer_text      TEXT NOT NULL,
  couldnt_catch    INTEGER NOT NULL DEFAULT 0,
  word_accuracy    REAL NOT NULL,
  exact_match      INTEGER NOT NULL,
  ref_word_count   INTEGER NOT NULL,
  alignment_json   TEXT NOT NULL,
  submitted_at     INTEGER NOT NULL
);
CREATE TRIGGER submitted_answers_no_update BEFORE UPDATE ON submitted_answers
BEGIN SELECT RAISE(ABORT, 'submitted answers are immutable'); END;
CREATE TRIGGER submitted_answers_no_delete BEFORE DELETE ON submitted_answers
BEGIN SELECT RAISE(ABORT, 'submitted answers are immutable'); END;

CREATE TABLE review_items (
  id                      INTEGER PRIMARY KEY,
  student_id              INTEGER NOT NULL REFERENCES users(id),
  test_id                 INTEGER NOT NULL REFERENCES tests(id),
  test_item_id            INTEGER NOT NULL REFERENCES test_items(id),
  segment_id              INTEGER NOT NULL REFERENCES audio_segments(id),
  source_item_attempt_id  INTEGER NOT NULL REFERENCES item_attempts(id),
  status                  TEXT NOT NULL CHECK (status IN (
                            'immediate_pending', 'immediate_in_progress',
                            'awaiting_delayed', 'delayed_in_progress', 'delayed_passed',
                            'remediation_pending', 'remediation_in_progress',
                            'teacher_hold', 'closed_by_teacher')),
  teacher_attention       INTEGER NOT NULL DEFAULT 0,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  delayed_cycles          INTEGER NOT NULL DEFAULT 0,
  immediate_completed_at  INTEGER,
  delayed_due_at          INTEGER,           -- original due time; never moved by presentation rules
  postponed_until         INTEGER,           -- teacher postponement of presentation only
  passed_at               INTEGER,
  transfer_eligible       INTEGER NOT NULL DEFAULT 0,
  support_note            TEXT NOT NULL DEFAULT '',
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  UNIQUE (student_id, test_item_id)
);

CREATE TABLE review_attempts (
  id                  INTEGER PRIMARY KEY,
  review_item_id      INTEGER NOT NULL REFERENCES review_items(id),
  kind                TEXT NOT NULL CHECK (kind IN ('immediate', 'delayed', 'remediation')),
  cycle               INTEGER NOT NULL DEFAULT 1,
  stage               TEXT NOT NULL CHECK (stage IN ('self_correction', 'feedback', 'guided', 'final_recall', 'listening', 'done')),
  prompt_answer       TEXT,                  -- answer shown at Stage A (original or failed delayed answer)
  draft_text          TEXT NOT NULL DEFAULT '',
  self_correction_text      TEXT,
  self_correction_accuracy  REAL,
  final_recall_text         TEXT,
  final_recall_accuracy     REAL,
  delayed_answer_text       TEXT,
  delayed_couldnt_catch     INTEGER,
  delayed_accuracy          REAL,
  delayed_result            TEXT CHECK (delayed_result IN ('passed', 'failed')),
  alignment_json            TEXT,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  credits_restored    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX review_attempts_item ON review_attempts (review_item_id);

-- Each authorized playback start. Counts are derived from or mirrored to these rows.
CREATE TABLE playback_events (
  id              INTEGER PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  student_id      INTEGER NOT NULL REFERENCES users(id),
  owner_type      TEXT NOT NULL CHECK (owner_type IN ('item_attempt', 'review_attempt')),
  owner_id        INTEGER NOT NULL,
  context         TEXT NOT NULL CHECK (context IN ('assessment', 'delayed_review', 'self_correction', 'guided_full', 'final_recall')),
  segment_id      INTEGER NOT NULL REFERENCES audio_segments(id),
  session_id      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('authorized', 'fetched', 'completed', 'interrupted')),
  duration_ms     INTEGER NOT NULL,
  authorized_at   INTEGER NOT NULL,
  fetched_at      INTEGER,
  ended_at        INTEGER,
  end_reason      TEXT
);
CREATE INDEX playback_events_owner ON playback_events (owner_type, owner_id, context);

CREATE TABLE activity_events (
  id              INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  student_id      INTEGER NOT NULL REFERENCES users(id),
  test_id         INTEGER,
  item_id         INTEGER,
  attempt_id      INTEGER,
  review_item_id  INTEGER,
  event_type      TEXT NOT NULL,
  server_ts       INTEGER NOT NULL,
  client_ts       INTEGER,
  metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX activity_events_student ON activity_events (student_id, server_ts);
CREATE INDEX activity_events_attempt ON activity_events (attempt_id);

CREATE TABLE teacher_actions (
  id           INTEGER PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    INTEGER,
  student_id   INTEGER,
  reason       TEXT NOT NULL DEFAULT '',
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

-- Per-student familiarity: a segment can be practised by one learner and unseen by another.
CREATE TABLE student_segment_exposure (
  student_id          INTEGER NOT NULL REFERENCES users(id),
  segment_id          INTEGER NOT NULL REFERENCES audio_segments(id),
  first_heard_at      INTEGER,
  transcript_seen_at  INTEGER,
  marked_by_teacher   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (student_id, segment_id)
);

CREATE TABLE idempotency_keys (
  user_id      INTEGER NOT NULL,
  key          TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
