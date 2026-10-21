import crypto from 'node:crypto';
import { tx } from '../db.js';
import { scoreAnswer } from '../lib/align.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { logEvent } from './activity.js';
import { interruptAll, playbackState } from './playback.js';
import { assertSession, openSession } from './sessions.js';

const MAX_ANSWER_LENGTH = 1000;
const DRAFT_EVENT_INTERVAL_MS = 30_000;

export function testWindow(test, assignment) {
  return {
    releaseAt: assignment?.release_at ?? test.release_at ?? null,
    dueAt: assignment?.due_at ?? test.due_at ?? null,
  };
}

/** What a student may see before listening. Scaffolding differs strictly by mode; transcripts never appear. */
export function prelistening(test) {
  const vocab = JSON.parse(test.vocab_json || '[]');
  switch (test.mode) {
    case 'recovery':
      return { mode: 'recovery', topic: test.topic, situation: null, vocab: [] };
    case 'training':
      return { mode: 'training', topic: null, situation: test.situation || test.topic, vocab: vocab.slice(0, 3) };
    case 'transfer':
      return { mode: 'transfer', topic: null, situation: test.situation, vocab: [] };
    default:
      throw new Error(`Unknown mode ${test.mode}`);
  }
}

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function familiarityFor(db, studentId, segment) {
  if (segment.familiarity_status === 'previously_practised') return 'previously_practised';
  const seen = db.prepare('SELECT 1 FROM student_segment_exposure WHERE student_id = ? AND segment_id = ?').get(studentId, segment.id);
  return seen ? 'previously_practised' : 'unseen';
}

function loadAssignedTest(db, studentId, testId) {
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId);
  const assignment = test && db.prepare('SELECT * FROM student_assignments WHERE test_id = ? AND student_id = ?').get(testId, studentId);
  if (!test || !assignment || test.status !== 'published') throw notFound('This test is not assigned to you.');
  return { test, assignment };
}

function loadOwnAttempt(db, studentId, attemptId) {
  const attempt = db.prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(attemptId);
  if (!attempt || attempt.student_id !== studentId) throw notFound();
  return attempt;
}

/** Create an attempt with a freshly shuffled, then frozen, sentence order. */
function createAttempt(ctx, { test, studentId, kind, attemptNo, startedAfterDue }) {
  const { db, clock } = ctx;
  const now = clock.now();
  const items = db.prepare(
    `SELECT ti.id, ti.position, s.id AS segment_id, s.familiarity_status
       FROM test_items ti JOIN audio_segments s ON s.id = ti.segment_id WHERE ti.test_id = ? ORDER BY ti.position`
  ).all(test.id);
  if (!items.length) throw conflict('NO_ITEMS', 'This test has no sentences yet.');
  const order = test.shuffle_items ? shuffled(items) : items;
  const info = db.prepare(
    `INSERT INTO assessment_attempts (test_id, student_id, attempt_kind, attempt_no, item_count, started_at, started_after_due)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(test.id, studentId, kind, attemptNo, order.length, now, startedAfterDue ? 1 : 0);
  const attemptId = Number(info.lastInsertRowid);
  const insertItem = db.prepare(
    `INSERT INTO item_attempts (attempt_id, test_item_id, segment_id, position, familiarity_at_start) VALUES (?, ?, ?, ?, ?)`
  );
  order.forEach((it, idx) => {
    insertItem.run(attemptId, it.id, it.segment_id, idx + 1,
      familiarityFor(db, studentId, { id: it.segment_id, familiarity_status: it.familiarity_status }));
  });
  logEvent(db, now, { studentId, testId: test.id, attemptId, type: 'test_started', metadata: { order: order.map((o) => o.id), kind, attemptNo } });
  return db.prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(attemptId);
}

function resumeAttempt(ctx, { studentId, attempt, resumeFrom }) {
  // Reload or reconnect: any play that was running is over. Its start stays counted.
  for (const ia of ctx.db.prepare('SELECT id FROM item_attempts WHERE attempt_id = ?').all(attempt.id)) {
    interruptAll(ctx, 'item_attempt', ia.id, 'reload');
  }
  logEvent(ctx.db, ctx.clock.now(), { studentId, testId: attempt.test_id, attemptId: attempt.id, type: 'session_resumed' });
}

function openAttemptSession(ctx, { studentId, attempt, resumeFrom }) {
  const session = openSession(ctx, {
    studentId, scopeType: 'test', scopeId: attempt.id, resumeFrom,
    log: { testId: attempt.test_id, attemptId: attempt.id },
  });
  return { attemptId: attempt.id, submitted: false, sessionId: session.id };
}

export function startAttempt(ctx, { studentId, testId, resumeFrom = null }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const now = clock.now();
    const { test, assignment } = loadAssignedTest(db, studentId, testId);
    const { releaseAt, dueAt } = testWindow(test, assignment);
    let attempt = db.prepare(
      "SELECT * FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'independent'"
    ).get(testId, studentId);
    if (!attempt) {
      if (releaseAt == null || now < releaseAt) throw forbidden('LOCKED', 'This test is not available yet.');
      // Overdue tests leave the student's list and are reported to the teacher, who can extend the due date.
      if (dueAt != null && now > dueAt) throw forbidden('OVERDUE', 'This test is overdue and has been sent to your teacher.');
      attempt = createAttempt(ctx, { test, studentId, kind: 'independent', attemptNo: 1, startedAfterDue: dueAt != null && now > dueAt });
    } else if (attempt.status === 'submitted') {
      return { attemptId: attempt.id, submitted: true, sessionId: null };
    } else {
      resumeAttempt(ctx, { studentId, attempt, resumeFrom });
    }
    return openAttemptSession(ctx, { studentId, attempt, resumeFrom });
  });
}

/**
 * Practice retake: same strict listening rules, scored separately. Allowed any number of times once the
 * original independent attempt is submitted; the original answers and score are never touched.
 */
export function startPractice(ctx, { studentId, testId, resumeFrom = null }) {
  const { db } = ctx;
  return tx(db, () => {
    const { test } = loadAssignedTest(db, studentId, testId);
    const original = db.prepare(
      "SELECT * FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'independent'"
    ).get(testId, studentId);
    if (original?.status !== 'submitted') throw conflict('FINISH_FIRST', 'Finish the test once before redoing it.');
    let attempt = db.prepare(
      "SELECT * FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'practice' AND status = 'in_progress'"
    ).get(testId, studentId);
    if (attempt) {
      resumeAttempt(ctx, { studentId, attempt, resumeFrom });
    } else {
      const next = db.prepare('SELECT MAX(attempt_no) FROM assessment_attempts WHERE test_id = ? AND student_id = ?').pluck().get(testId, studentId) + 1;
      attempt = createAttempt(ctx, { test, studentId, kind: 'practice', attemptNo: next, startedAfterDue: false });
    }
    return openAttemptSession(ctx, { studentId, attempt, resumeFrom });
  });
}

function itemView(ctx, ia) {
  const plays = playbackState(ctx, 'item_attempt', ia.id, 'assessment', ia.credits_restored);
  return {
    id: ia.id,
    position: ia.position,
    status: ia.status,
    draft: ia.draft_text,
    plays,
    canWrite: plays.completed >= 1 && !plays.inFlight && ia.status !== 'submitted',
    canCouldntCatch: plays.used >= 1 && !plays.inFlight && ia.status !== 'submitted',
    // Every listen was used and none finished: a technical problem, not a learner outcome.
    recovery: plays.completed === 0 && plays.used >= plays.allowed && !plays.inFlight,
  };
}

export function getAttemptState(ctx, { studentId, attemptId }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const attempt = loadOwnAttempt(db, studentId, attemptId);
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(attempt.test_id);
    const base = {
      attempt: {
        id: attempt.id, status: attempt.status, currentPosition: attempt.current_position, itemCount: attempt.item_count,
        kind: attempt.attempt_kind, practiceNo: attempt.attempt_kind === 'practice' ? attempt.attempt_no - 1 : null,
      },
      test: { id: test.id, number: test.number, title: test.title, mode: test.mode, prelistening: prelistening(test) },
      pasteException: Boolean(db.prepare('SELECT cp_paste_exception FROM users WHERE id = ?').pluck().get(studentId)),
    };
    if (attempt.status === 'submitted') {
      return { ...base, summary: attempt.attempt_kind === 'practice' ? practiceSummary(db, attempt) : attemptSummary(db, attempt.id) };
    }
    const ia = db.prepare('SELECT * FROM item_attempts WHERE attempt_id = ? AND position = ?').get(attempt.id, attempt.current_position);
    if (ia.status === 'pending') {
      const now = clock.now();
      db.prepare("UPDATE item_attempts SET status = 'open', opened_at = ? WHERE id = ?").run(now, ia.id);
      logEvent(db, now, { studentId, testId: test.id, attemptId: attempt.id, itemId: ia.test_item_id, type: 'item_opened', metadata: { position: ia.position } });
      ia.status = 'open';
    }
    return { ...base, item: itemView(ctx, ia) };
  });
}

function loadCurrentItem(db, attempt, itemAttemptId) {
  const ia = db.prepare('SELECT * FROM item_attempts WHERE id = ? AND attempt_id = ?').get(itemAttemptId, attempt.id);
  if (!ia) throw notFound();
  if (ia.status === 'submitted') throw conflict('ALREADY_SUBMITTED', 'This sentence has already been submitted and is locked.');
  if (ia.position !== attempt.current_position) throw conflict('NOT_CURRENT_ITEM', 'You can only work on the current sentence.');
  return ia;
}

function cleanText(text) {
  if (text != null && typeof text !== 'string') throw badRequest('INVALID_TEXT', 'Answer must be text.');
  const t = (text ?? '').replace(/\r\n/g, '\n');
  if (t.length > MAX_ANSWER_LENGTH) throw badRequest('TOO_LONG', `Answers are limited to ${MAX_ANSWER_LENGTH} characters.`);
  return t;
}

/** Shared guard for authorizing a play from the assessment route. */
export function assertCanPlayItem(ctx, { studentId, attemptId, itemAttemptId, sessionId }) {
  const attempt = loadOwnAttempt(ctx.db, studentId, attemptId);
  if (attempt.status !== 'in_progress') throw conflict('TEST_SUBMITTED', 'This test has been submitted.');
  assertSession(ctx, { sessionId, studentId, scopeType: 'test', scopeId: attempt.id });
  loadCurrentItem(ctx.db, attempt, itemAttemptId);
}

export function saveDraft(ctx, { studentId, attemptId, itemAttemptId, sessionId, text }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const attempt = loadOwnAttempt(db, studentId, attemptId);
    if (attempt.status !== 'in_progress') throw conflict('TEST_SUBMITTED', 'This test has been submitted.');
    assertSession(ctx, { sessionId, studentId, scopeType: 'test', scopeId: attempt.id });
    const ia = loadCurrentItem(db, attempt, itemAttemptId);
    const view = itemView(ctx, ia);
    if (view.plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    if (!view.canWrite) throw conflict('WRITING_LOCKED', 'Listen to the complete sentence first.');
    const now = clock.now();
    const body = cleanText(text);
    db.prepare('UPDATE item_attempts SET draft_text = ?, draft_saved_at = ? WHERE id = ?').run(body, now, ia.id);
    if (!ia.draft_saved_at || now - ia.draft_saved_at >= DRAFT_EVENT_INTERVAL_MS) {
      logEvent(db, now, { studentId, testId: attempt.test_id, attemptId: attempt.id, itemId: ia.test_item_id, type: 'draft_saved', metadata: { length: body.length } });
    }
    return { savedAt: now };
  });
}

export function submitItem(ctx, { studentId, attemptId, itemAttemptId, sessionId, text, couldntCatch = false }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const attempt = loadOwnAttempt(db, studentId, attemptId);
    if (attempt.status !== 'in_progress') throw conflict('TEST_SUBMITTED', 'This test has already been submitted.');
    assertSession(ctx, { sessionId, studentId, scopeType: 'test', scopeId: attempt.id });
    const ia = loadCurrentItem(db, attempt, itemAttemptId);
    const view = itemView(ctx, ia);
    if (view.plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    const answer = couldntCatch ? '' : cleanText(text);
    if (couldntCatch ? !view.canCouldntCatch : !view.canWrite) {
      throw conflict('WRITING_LOCKED', 'Listen to the complete sentence before submitting.');
    }
    const now = clock.now();
    const segment = db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').get(ia.segment_id);
    const score = scoreAnswer(segment.transcript, answer);
    db.prepare(
      `INSERT INTO submitted_answers
         (item_attempt_id, attempt_id, student_id, answer_text, couldnt_catch, word_accuracy, exact_match, ref_word_count, alignment_json, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ia.id, attempt.id, studentId, answer, couldntCatch ? 1 : 0, score.wordAccuracy, score.exact ? 1 : 0,
      score.refWordCount, JSON.stringify(score.ops), now);
    db.prepare("UPDATE item_attempts SET status = 'submitted', submitted_at = ?, draft_text = ? WHERE id = ?").run(now, answer, ia.id);
    logEvent(db, now, {
      studentId, testId: attempt.test_id, attemptId: attempt.id, itemId: ia.test_item_id, type: 'answer_submitted',
      metadata: {
        position: ia.position, couldntCatch: Boolean(couldntCatch), plays: view.plays.used,
        msSincePlayCompleted: ia.last_play_completed_at ? now - ia.last_play_completed_at : null,
        words: answer.trim() ? answer.trim().split(/\s+/).length : 0,
      },
    });
    const isLast = ia.position >= attempt.item_count;
    if (!isLast) {
      db.prepare('UPDATE assessment_attempts SET current_position = current_position + 1 WHERE id = ?').run(attempt.id);
      return { finished: false, nextPosition: ia.position + 1 };
    }
    finalizeAttempt(ctx, attempt, now);
    return { finished: true, summary: attempt.attempt_kind === 'practice' ? practiceSummary(db, attempt) : attemptSummary(db, attempt.id) };
  });
}

function finalizeAttempt(ctx, attempt, now) {
  const { db } = ctx;
  db.prepare("UPDATE assessment_attempts SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now, attempt.id);
  db.prepare("UPDATE cp_sessions SET ended_at = ?, ended_reason = 'test_submitted' WHERE scope_type = 'test' AND scope_id = ? AND ended_at IS NULL")
    .run(now, attempt.id);
  if (attempt.attempt_kind === 'practice') {
    logEvent(db, now, { studentId: attempt.student_id, testId: attempt.test_id, attemptId: attempt.id, type: 'test_submitted', metadata: { kind: 'practice' } });
    return;
  }
  const wrong = db.prepare(
    `SELECT ia.id, ia.test_item_id, ia.segment_id FROM item_attempts ia
       JOIN submitted_answers sa ON sa.item_attempt_id = ia.id
      WHERE ia.attempt_id = ? AND sa.exact_match = 0 ORDER BY ia.position`
  ).all(attempt.id);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO review_items (student_id, test_id, test_item_id, segment_id, source_item_attempt_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'immediate_pending', ?, ?)`
  );
  for (const w of wrong) insert.run(attempt.student_id, attempt.test_id, w.test_item_id, w.segment_id, w.id, now, now);
  logEvent(db, now, {
    studentId: attempt.student_id, testId: attempt.test_id, attemptId: attempt.id, type: 'test_submitted',
    metadata: { reviewItemsCreated: wrong.length },
  });
}

/** Feedback after the whole test is locked. Transcripts are revealed only inside the review flow. */
export function attemptSummary(db, attemptId) {
  const rows = db.prepare(
    `SELECT ia.position, ia.test_item_id, ia.playback_start_count, sa.answer_text, sa.couldnt_catch, sa.word_accuracy, sa.exact_match,
            ri.id AS review_item_id, ri.status AS review_status
       FROM item_attempts ia
       JOIN submitted_answers sa ON sa.item_attempt_id = ia.id
       JOIN assessment_attempts a ON a.id = ia.attempt_id
       LEFT JOIN review_items ri ON ri.source_item_attempt_id = ia.id
      WHERE ia.attempt_id = ? ORDER BY ia.position`
  ).all(attemptId);
  const n = rows.length || 1;
  return {
    items: rows.map((r) => ({
      position: r.position,
      answer: r.answer_text,
      couldntCatch: Boolean(r.couldnt_catch),
      wordAccuracy: r.word_accuracy,
      correct: Boolean(r.exact_match),
      plays: r.playback_start_count,
      reviewItemId: r.review_item_id,
      reviewStatus: r.review_status,
    })),
    wordAccuracy: Math.round((rows.reduce((s, r) => s + r.word_accuracy, 0) / n) * 1000) / 1000,
    exactCount: rows.filter((r) => r.exact_match).length,
    unanswered: rows.filter((r) => r.couldnt_catch || !r.answer_text.trim()).length,
    itemCount: rows.length,
  };
}

/**
 * Practice retake results next to the original attempt. A transcript is shown only for sentences the student
 * already got right or has already seen in a review, so a retake never skips the guided review step.
 */
export function practiceSummary(db, attempt) {
  const base = attemptSummary(db, attempt.id);
  const original = db.prepare(
    "SELECT id FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'independent'"
  ).pluck().get(attempt.test_id, attempt.student_id);
  const originalByItem = new Map(db.prepare(
    `SELECT ia.test_item_id, sa.word_accuracy, sa.exact_match FROM item_attempts ia
       JOIN submitted_answers sa ON sa.item_attempt_id = ia.id WHERE ia.attempt_id = ?`
  ).all(original).map((r) => [r.test_item_id, r]));
  const rows = db.prepare(
    `SELECT ia.position, ia.test_item_id, s.transcript, sa.alignment_json, sa.exact_match,
            e.transcript_seen_at, ri.id AS review_item_id
       FROM item_attempts ia JOIN audio_segments s ON s.id = ia.segment_id
       JOIN submitted_answers sa ON sa.item_attempt_id = ia.id
       LEFT JOIN student_segment_exposure e ON e.student_id = ? AND e.segment_id = ia.segment_id
       LEFT JOIN review_items ri ON ri.student_id = ? AND ri.test_item_id = ia.test_item_id
      WHERE ia.attempt_id = ? ORDER BY ia.position`
  ).all(attempt.student_id, attempt.student_id, attempt.id);
  const originalSummary = attemptSummary(db, original);
  return {
    ...base,
    practice: true,
    practiceNo: attempt.attempt_no - 1,
    original: { wordAccuracy: originalSummary.wordAccuracy, exactCount: originalSummary.exactCount },
    items: base.items.map((it, i) => {
      const r = rows[i];
      const orig = originalByItem.get(r.test_item_id);
      const reveal = r.exact_match || r.transcript_seen_at;
      return {
        ...it,
        reviewItemId: r.review_item_id ?? null,
        originalCorrect: Boolean(orig?.exact_match),
        originalAccuracy: orig?.word_accuracy ?? null,
        transcript: reveal ? r.transcript : null,
        ops: reveal ? JSON.parse(r.alignment_json) : null,
      };
    }),
  };
}

export function heartbeat(ctx, { studentId, sessionId, visible }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const s = db.prepare('SELECT * FROM cp_sessions WHERE id = ? AND student_id = ?').get(sessionId, studentId);
    if (!s) throw notFound();
    if (s.ended_at) throw conflict('SESSION_SUPERSEDED', 'This activity was opened in another tab or device.');
    const now = clock.now();
    db.prepare('UPDATE cp_sessions SET last_seen_at = ? WHERE id = ?').run(now, s.id);
    if (s.scope_type === 'test') {
      const a = db.prepare('SELECT * FROM assessment_attempts WHERE id = ?').get(s.scope_id);
      if (a.status === 'in_progress') {
        // Approximate active time: visible heartbeats, each credited for at most 30 seconds.
        const add = visible && a.last_heartbeat_at ? Math.min(now - a.last_heartbeat_at, 30_000) : 0;
        db.prepare('UPDATE assessment_attempts SET active_ms = active_ms + ?, last_heartbeat_at = ? WHERE id = ?').run(add, now, a.id);
      }
    }
    return { ok: true };
  });
}
