import { tx } from '../db.js';
import { scoreAnswer } from '../lib/align.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { DAY, dayStart, HOUR, localDate } from '../lib/time.js';
import { logEvent } from './activity.js';
import { interruptAll, playbackState, recordTranscriptSeen } from './playback.js';
import { assertSession, openSession } from './sessions.js';
import { getSettings } from './settings.js';

export const DELAYED_REVIEW_INTERVAL_MS = 48 * HOUR;
export const FAILURES_FOR_TEACHER_ATTENTION = 2;
const MAX_ANSWER_LENGTH = 1000;

const STAGE_PLAY_CONTEXT = {
  self_correction: 'self_correction',
  guided: 'guided_full',
  final_recall: 'final_recall',
  listening: 'delayed_review',
};

function cleanText(text) {
  if (text != null && typeof text !== 'string') throw badRequest('INVALID_TEXT', 'Answer must be text.');
  const t = (text ?? '').replace(/\r\n/g, '\n');
  if (t.length > MAX_ANSWER_LENGTH) throw badRequest('TOO_LONG', `Answers are limited to ${MAX_ANSWER_LENGTH} characters.`);
  return t;
}

function loadOwnItem(db, studentId, reviewItemId) {
  const item = db.prepare('SELECT * FROM review_items WHERE id = ?').get(reviewItemId);
  if (!item || item.student_id !== studentId) throw notFound();
  return item;
}

function loadOwnAttempt(db, studentId, reviewAttemptId) {
  const attempt = db.prepare('SELECT * FROM review_attempts WHERE id = ?').get(reviewAttemptId);
  if (!attempt) throw notFound();
  const item = loadOwnItem(db, studentId, attempt.review_item_id);
  return { attempt, item };
}

/** End of the day (Asia/Ho_Chi_Minh) on which a delayed review is shown; after that it is overdue. */
export function delayedDeadline(item) {
  const shownFrom = item.postponed_until ?? item.delayed_due_at;
  return shownFrom == null ? null : dayStart(localDate(shownFrom)) + DAY - 1;
}

function isPresentable(item, now) {
  return item.delayed_due_at != null && item.delayed_due_at <= now && !(item.postponed_until && item.postponed_until > now);
}

function kindFor(item, now) {
  switch (item.status) {
    case 'immediate_pending':
    case 'immediate_in_progress':
      return 'immediate';
    case 'remediation_pending':
    case 'remediation_in_progress':
      return 'remediation';
    case 'delayed_in_progress':
      return 'delayed';
    case 'awaiting_delayed':
      if (!isPresentable(item, now)) throw forbidden('NOT_DUE', 'This review is not due yet.');
      // Overdue reviews leave the student's list and go to the teacher, who can postpone them to reopen.
      if (delayedDeadline(item) < now) throw forbidden('OVERDUE', 'This review is overdue and has been sent to your teacher.');
      return 'delayed';
    default:
      throw conflict('NO_REVIEW_OPEN', 'There is no review to do for this sentence right now.');
  }
}

/**
 * Which not-yet-started Immediate (Guided) Reviews may begin today. At most daily_guided_review_limit
 * may be started per day; the rest wait in the pending remediation queue, oldest test first, then by
 * sentence order. No delayed review is scheduled for a waiting item until its guided review is done.
 */
export function guidedReviewPlan(db, studentId, now) {
  const { daily_guided_review_limit: limit } = getSettings(db);
  const todayStart = dayStart(localDate(now));
  const startedToday = db.prepare(
    `SELECT COUNT(*) FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id
      WHERE ri.student_id = ? AND ra.kind = 'immediate' AND ra.started_at >= ?`
  ).pluck().get(studentId, todayStart);
  const waiting = db.prepare(
    `SELECT ri.id FROM review_items ri JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id
      WHERE ri.student_id = ? AND ri.status = 'immediate_pending' ORDER BY ri.created_at, ia.attempt_id, ia.position`
  ).pluck().all(studentId);
  const slots = Math.max(0, limit - startedToday);
  return { limit, startedToday, today: new Set(waiting.slice(0, slots)), pending: new Set(waiting.slice(slots)) };
}

const IN_PROGRESS_STATUS = { immediate: 'immediate_in_progress', delayed: 'delayed_in_progress', remediation: 'remediation_in_progress' };

export function startReview(ctx, { studentId, reviewItemId, resumeFrom = null }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const now = clock.now();
    const item = loadOwnItem(db, studentId, reviewItemId);
    const kind = kindFor(item, now);
    let attempt = db.prepare(
      'SELECT * FROM review_attempts WHERE review_item_id = ? AND kind = ? AND completed_at IS NULL ORDER BY id DESC'
    ).get(item.id, kind);
    const log = { testId: item.test_id, itemId: item.test_item_id, reviewItemId: item.id };
    if (!attempt) {
      if (kind === 'immediate' && !guidedReviewPlan(db, studentId, now).today.has(item.id)) {
        throw forbidden('GUIDED_LIMIT_REACHED', 'You have reached today\'s Guided Review limit. This sentence is in your pending queue for another day.');
      }
      let promptAnswer = null;
      if (kind === 'immediate') {
        promptAnswer = db.prepare('SELECT answer_text FROM submitted_answers WHERE item_attempt_id = ?').pluck().get(item.source_item_attempt_id);
      } else if (kind === 'remediation') {
        promptAnswer = db.prepare(
          "SELECT delayed_answer_text FROM review_attempts WHERE review_item_id = ? AND kind = 'delayed' AND completed_at IS NOT NULL ORDER BY id DESC"
        ).pluck().get(item.id);
      }
      const cycle = kind === 'immediate' ? 1 : item.delayed_cycles + (kind === 'delayed' ? 1 : 0);
      const info = db.prepare(
        `INSERT INTO review_attempts (review_item_id, kind, cycle, stage, prompt_answer, started_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(item.id, kind, cycle, kind === 'delayed' ? 'listening' : 'self_correction', promptAnswer, now);
      attempt = db.prepare('SELECT * FROM review_attempts WHERE id = ?').get(info.lastInsertRowid);
      db.prepare('UPDATE review_items SET status = ?, updated_at = ? WHERE id = ?').run(IN_PROGRESS_STATUS[kind], now, item.id);
      const startType = { immediate: 'immediate_review_started', delayed: 'delayed_review_started', remediation: 'remediation_started' }[kind];
      logEvent(db, now, { studentId, ...log, type: startType, metadata: { reviewAttemptId: attempt.id, cycle } });
    } else {
      interruptAll(ctx, 'review_attempt', attempt.id, 'reload');
    }
    const session = openSession(ctx, { studentId, scopeType: 'review', scopeId: attempt.id, resumeFrom, log });
    return { reviewAttemptId: attempt.id, sessionId: session.id };
  });
}

function scoreView(score) {
  return {
    wordAccuracy: score.wordAccuracy, exact: score.exact, ops: score.ops,
    missing: score.missing, extra: score.extra, substituted: score.substituted,
  };
}

export function getReviewState(ctx, { studentId, reviewAttemptId }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const { attempt, item } = loadOwnAttempt(db, studentId, reviewAttemptId);
    const test = db.prepare('SELECT id, number, title FROM tests WHERE id = ?').get(item.test_id);
    const base = {
      reviewItem: {
        id: item.id, status: item.status, teacherAttention: Boolean(item.teacher_attention),
        consecutiveFailures: item.consecutive_failures, supportNote: item.support_note,
      },
      attempt: { id: attempt.id, kind: attempt.kind, stage: attempt.stage, cycle: attempt.cycle, draft: attempt.draft_text },
      test,
      pasteException: Boolean(db.prepare('SELECT cp_paste_exception FROM users WHERE id = ?').pluck().get(studentId)),
    };
    const context = STAGE_PLAY_CONTEXT[attempt.stage];
    const plays = context ? playbackState(ctx, 'review_attempt', attempt.id, context, attempt.credits_restored) : null;
    const transcript = () => {
      recordTranscriptSeen(db, studentId, item.segment_id, clock.now());
      return db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
    };
    switch (attempt.stage) {
      case 'self_correction':
        return { ...base, promptAnswer: attempt.prompt_answer ?? '', plays, canWrite: !plays.inFlight };
      case 'feedback': {
        const ref = transcript();
        return {
          ...base, transcript: ref,
          original: { text: attempt.prompt_answer ?? '', ...scoreView(scoreAnswer(ref, attempt.prompt_answer ?? '')) },
          revised: { text: attempt.self_correction_text ?? '', ...scoreView(scoreAnswer(ref, attempt.self_correction_text ?? '')) },
        };
      }
      case 'guided':
        return { ...base, transcript: transcript(), plays };
      case 'final_recall':
        return { ...base, plays, canWrite: plays.used >= 1 && !plays.inFlight };
      case 'listening':
        return {
          ...base, plays,
          canWrite: plays.completed >= 1 && !plays.inFlight,
          canCouldntCatch: plays.used >= 1 && !plays.inFlight,
          recovery: plays.completed === 0 && plays.used >= plays.allowed && !plays.inFlight,
        };
      case 'done':
        return { ...base, result: attempt.delayed_result, finalRecallAccuracy: attempt.final_recall_accuracy, delayedDueAt: item.delayed_due_at };
      default:
        throw new Error(`Unknown stage ${attempt.stage}`);
    }
  });
}

function openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId, stage }) {
  const { attempt, item } = loadOwnAttempt(ctx.db, studentId, reviewAttemptId);
  if (attempt.completed_at) throw conflict('REVIEW_COMPLETED', 'This review is already complete.');
  assertSession(ctx, { sessionId, studentId, scopeType: 'review', scopeId: attempt.id });
  if (stage && attempt.stage !== stage) throw conflict('WRONG_STAGE', 'This step is not available right now.', { stage: attempt.stage });
  return { attempt, item };
}

export function assertCanPlayReview(ctx, { studentId, reviewAttemptId, sessionId }) {
  const { attempt } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId });
  const context = STAGE_PLAY_CONTEXT[attempt.stage];
  if (!context) throw conflict('NO_AUDIO_STAGE', 'Audio is not available at this step.');
  return context;
}

export function saveReviewDraft(ctx, { studentId, reviewAttemptId, sessionId, text }) {
  return tx(ctx.db, () => {
    const { attempt } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId });
    if (!['self_correction', 'final_recall', 'listening'].includes(attempt.stage)) throw conflict('WRONG_STAGE', 'Nothing to save at this step.');
    const plays = playbackState(ctx, 'review_attempt', attempt.id, STAGE_PLAY_CONTEXT[attempt.stage], attempt.credits_restored);
    if (plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    if (attempt.stage === 'listening' && plays.completed < 1) throw conflict('WRITING_LOCKED', 'Listen to the complete sentence first.');
    ctx.db.prepare('UPDATE review_attempts SET draft_text = ? WHERE id = ?').run(cleanText(text), attempt.id);
    return { savedAt: ctx.clock.now() };
  });
}

/** Stage A → B. The revised answer is stored separately from the original. */
export function submitSelfCorrection(ctx, { studentId, reviewAttemptId, sessionId, text }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const { attempt, item } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId, stage: 'self_correction' });
    const plays = playbackState(ctx, 'review_attempt', attempt.id, 'self_correction');
    if (plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    const revised = cleanText(text);
    const ref = db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
    const score = scoreAnswer(ref, revised);
    db.prepare(
      `UPDATE review_attempts SET self_correction_text = ?, self_correction_accuracy = ?, stage = 'feedback', draft_text = '' WHERE id = ?`
    ).run(revised, score.wordAccuracy, attempt.id);
    logEvent(db, clock.now(), {
      studentId, testId: item.test_id, itemId: item.test_item_id, reviewItemId: item.id, type: 'self_correction_submitted',
      metadata: { reviewAttemptId: attempt.id, plays: plays.used },
    });
    return { stage: 'feedback' };
  });
}

/** Feedback → Guided listening → Final recall. */
export function advanceStage(ctx, { studentId, reviewAttemptId, sessionId, from }) {
  const next = { feedback: 'guided', guided: 'final_recall' }[from];
  if (!next) throw badRequest('INVALID_STAGE', 'Cannot advance from this step.');
  return tx(ctx.db, () => {
    const { attempt } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId, stage: from });
    if (from === 'guided') interruptAll(ctx, 'review_attempt', attempt.id, 'stage_advanced');
    ctx.db.prepare('UPDATE review_attempts SET stage = ? WHERE id = ?').run(next, attempt.id);
    return { stage: next };
  });
}

/** Stage D. Saved as guided recall; never overwrites the independent answer. Completes the review cycle. */
export function submitFinalRecall(ctx, { studentId, reviewAttemptId, sessionId, text }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const { attempt, item } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId, stage: 'final_recall' });
    const plays = playbackState(ctx, 'review_attempt', attempt.id, 'final_recall');
    if (plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    if (plays.used < 1) throw conflict('WRITING_LOCKED', 'Listen to the sentence first.');
    const now = clock.now();
    const recall = cleanText(text);
    const ref = db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
    const score = scoreAnswer(ref, recall);
    db.prepare(
      `UPDATE review_attempts SET final_recall_text = ?, final_recall_accuracy = ?, stage = 'done', completed_at = ?, draft_text = '' WHERE id = ?`
    ).run(recall, score.wordAccuracy, now, attempt.id);
    endReviewSessions(db, attempt.id, now);
    const log = { studentId, testId: item.test_id, itemId: item.test_item_id, reviewItemId: item.id };
    if (attempt.kind === 'immediate') {
      db.prepare('UPDATE review_items SET immediate_completed_at = ? WHERE id = ?').run(now, item.id);
      logEvent(db, now, { ...log, type: 'immediate_review_completed', metadata: { reviewAttemptId: attempt.id, finalRecallAccuracy: score.wordAccuracy } });
    } else {
      logEvent(db, now, { ...log, type: 'remediation_completed', metadata: { reviewAttemptId: attempt.id, finalRecallAccuracy: score.wordAccuracy } });
    }
    // Repeated failure: teacher intervention takes priority over another automatic cycle.
    if (item.teacher_attention) {
      db.prepare("UPDATE review_items SET status = 'teacher_hold', updated_at = ? WHERE id = ?").run(now, item.id);
      return { completed: true, delayedDueAt: null, teacherHold: true };
    }
    const dueAt = now + DELAYED_REVIEW_INTERVAL_MS;
    db.prepare("UPDATE review_items SET status = 'awaiting_delayed', delayed_due_at = ?, postponed_until = NULL, updated_at = ? WHERE id = ?")
      .run(dueAt, now, item.id);
    return { completed: true, delayedDueAt: dueAt, teacherHold: false };
  });
}

/** Delayed review answer: same strict two-play policy as the independent test. */
export function submitDelayedReview(ctx, { studentId, reviewAttemptId, sessionId, text, couldntCatch = false }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const { attempt, item } = openAttemptForStudent(ctx, { studentId, reviewAttemptId, sessionId, stage: 'listening' });
    const plays = playbackState(ctx, 'review_attempt', attempt.id, 'delayed_review', attempt.credits_restored);
    if (plays.inFlight) throw conflict('PLAYBACK_ACTIVE', 'Wait until the audio has finished.');
    if (couldntCatch ? plays.used < 1 : plays.completed < 1) throw conflict('WRITING_LOCKED', 'Listen to the complete sentence before submitting.');
    const now = clock.now();
    const answer = couldntCatch ? '' : cleanText(text);
    const ref = db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
    const score = scoreAnswer(ref, answer);
    const passed = score.exact;
    db.prepare(
      `UPDATE review_attempts SET delayed_answer_text = ?, delayed_couldnt_catch = ?, delayed_accuracy = ?, delayed_result = ?,
              alignment_json = ?, stage = 'done', completed_at = ?, draft_text = '' WHERE id = ?`
    ).run(answer, couldntCatch ? 1 : 0, score.wordAccuracy, passed ? 'passed' : 'failed', JSON.stringify(score.ops), now, attempt.id);
    endReviewSessions(db, attempt.id, now);
    const cycles = item.delayed_cycles + 1;
    if (passed) {
      db.prepare(
        `UPDATE review_items SET status = 'delayed_passed', passed_at = ?, consecutive_failures = 0, delayed_cycles = ?,
                transfer_eligible = 1, updated_at = ? WHERE id = ?`
      ).run(now, cycles, now, item.id);
    } else {
      const failures = item.consecutive_failures + 1;
      const attention = failures >= FAILURES_FOR_TEACHER_ATTENTION ? 1 : item.teacher_attention;
      db.prepare(
        `UPDATE review_items SET status = 'remediation_pending', consecutive_failures = ?, delayed_cycles = ?,
                teacher_attention = ?, updated_at = ? WHERE id = ?`
      ).run(failures, cycles, attention, now, item.id);
    }
    logEvent(db, now, {
      studentId, testId: item.test_id, itemId: item.test_item_id, reviewItemId: item.id, type: 'delayed_review_completed',
      metadata: { reviewAttemptId: attempt.id, result: passed ? 'passed' : 'failed', wordAccuracy: score.wordAccuracy, cycle: cycles, plays: plays.used },
    });
    return { result: passed ? 'passed' : 'failed', wordAccuracy: score.wordAccuracy };
  });
}

function endReviewSessions(db, reviewAttemptId, now) {
  db.prepare("UPDATE cp_sessions SET ended_at = ?, ended_reason = 'completed' WHERE scope_type = 'review' AND scope_id = ? AND ended_at IS NULL")
    .run(now, reviewAttemptId);
}

export function assertGuidedAudio(ctx, { studentId, reviewAttemptId }) {
  const { attempt, item } = loadOwnAttempt(ctx.db, studentId, reviewAttemptId);
  if (attempt.completed_at || attempt.stage !== 'guided') throw forbidden('WRONG_STAGE', 'Guided audio is only available during Guided Listening.');
  return ctx.db.prepare('SELECT clip_path FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
}

/**
 * Review Queue. Original due times are never changed; the daily cap only decides which due items
 * are mandatory today. Priority: oldest due first, then more repeated failures first.
 */
export function reviewQueue(ctx, studentId) {
  const { db, clock } = ctx;
  const now = clock.now();
  const today = localDate(now);
  const todayStart = dayStart(today);
  const items = db.prepare(
    `SELECT ri.*, t.number AS test_number, t.title AS test_title, ia.position
       FROM review_items ri JOIN tests t ON t.id = ri.test_id
       JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id
      WHERE ri.student_id = ? ORDER BY ri.id`
  ).all(studentId);
  const settings = getSettings(db);
  const completedToday = db.prepare(
    `SELECT COUNT(*) FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id
      WHERE ri.student_id = ? AND ra.kind = 'delayed' AND ra.completed_at >= ?`
  ).pluck().get(studentId, todayStart);
  const guided = guidedReviewPlan(db, studentId, now);

  const view = (i, extra = {}) => ({
    id: i.id, testId: i.test_id, testNumber: i.test_number, testTitle: i.test_title, sentence: i.position,
    status: i.status, dueAt: i.delayed_due_at, postponedUntil: i.postponed_until,
    consecutiveFailures: i.consecutive_failures, cycles: i.delayed_cycles,
    teacherAttention: Boolean(i.teacher_attention), supportNote: i.support_note, ...extra,
  });

  const delayedDue = items
    .filter((i) => (i.status === 'awaiting_delayed' && isPresentable(i, now)) || i.status === 'delayed_in_progress')
    .sort((a, b) => a.delayed_due_at - b.delayed_due_at || b.consecutive_failures - a.consecutive_failures || a.id - b.id);
  const slots = Math.max(0, settings.daily_delayed_review_cap - completedToday);
  const endOfToday = todayStart + DAY - 1;
  const prioritized = delayedDue.map((i, idx) => view(i, {
    kind: 'delayed',
    mandatory: idx < slots,
    deadline: delayedDeadline(i),
    overdue: i.status === 'awaiting_delayed' && delayedDeadline(i) < now,
  }));

  // Guided reviews and remediation open today are due by the end of today.
  const immediate = items.filter((i) => i.status === 'immediate_in_progress' || guided.today.has(i.id))
    .map((i) => view(i, { kind: 'immediate', mandatory: true, overdue: false, deadline: endOfToday }));
  const pendingRemediation = items.filter((i) => guided.pending.has(i.id))
    .map((i) => view(i, { kind: 'immediate', waiting: true }));
  const remediation = items.filter((i) => i.status === 'remediation_pending' || i.status === 'remediation_in_progress')
    .map((i) => view(i, { kind: 'remediation', mandatory: true, overdue: false, deadline: endOfToday }));

  return {
    today,
    dailyCap: settings.daily_delayed_review_cap,
    delayedCompletedToday: completedToday,
    guidedLimit: guided.limit,
    guidedStartedToday: guided.startedToday,
    overdue: [...immediate.filter((i) => i.overdue), ...prioritized.filter((i) => i.overdue)],
    dueToday: [...immediate.filter((i) => !i.overdue), ...remediation, ...prioritized.filter((i) => !i.overdue)],
    pendingRemediation,
    upcoming: items.filter((i) => i.status === 'awaiting_delayed' && !isPresentable(i, now))
      .sort((a, b) => (a.postponed_until ?? a.delayed_due_at) - (b.postponed_until ?? b.delayed_due_at))
      .map((i) => view(i, { kind: 'delayed' })),
    passed: items.filter((i) => i.status === 'delayed_passed').map((i) => view(i, { passedAt: i.passed_at })),
    teacherAttention: items.filter((i) => i.teacher_attention || i.status === 'teacher_hold').map((i) => view(i)),
  };
}

/** Startup consistency check: an item waiting for delayed review must always have a due time. */
export function repairReviewSchedules(db, now) {
  return db.prepare(
    `UPDATE review_items SET delayed_due_at = COALESCE(immediate_completed_at, updated_at, ?) + ?
      WHERE status = 'awaiting_delayed' AND delayed_due_at IS NULL`
  ).run(now, DELAYED_REVIEW_INTERVAL_MS).changes;
}

// ---------------------------------------------------------------- free practice of missed sentences
// Open to any sentence whose Guided Review is finished (the student has already seen its transcript).
// Practice is unlimited and never changes review status, scheduling or any score.

function loadPracticeItem(db, studentId, reviewItemId) {
  const item = loadOwnItem(db, studentId, reviewItemId);
  if (!item.immediate_completed_at) {
    throw forbidden('REVIEW_FIRST', 'Finish the Guided Review for this sentence before practising it freely.');
  }
  return item;
}

export function practiceList(ctx, studentId) {
  return ctx.db.prepare(
    `SELECT ri.id, ri.status, ri.test_id, t.title AS test_title, t.number AS test_number, ia.position AS sentence,
            (SELECT COUNT(*) FROM review_practice p WHERE p.review_item_id = ri.id) AS checks,
            (SELECT exact_match FROM review_practice p WHERE p.review_item_id = ri.id ORDER BY p.id DESC LIMIT 1) AS last_correct
       FROM review_items ri JOIN tests t ON t.id = ri.test_id JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id
      WHERE ri.student_id = ? AND ri.immediate_completed_at IS NOT NULL
      ORDER BY t.number, ia.position`
  ).all(studentId).map((r) => ({
    id: r.id, testId: r.test_id, testTitle: r.test_title, testNumber: r.test_number, sentence: r.sentence,
    status: r.status, checks: r.checks, lastCorrect: r.last_correct == null ? null : Boolean(r.last_correct),
  }));
}

export function practiceState(ctx, { studentId, reviewItemId }) {
  const { db } = ctx;
  const item = loadPracticeItem(db, studentId, reviewItemId);
  const list = practiceList(ctx, studentId);
  const idx = list.findIndex((r) => r.id === item.id);
  return {
    item: list[idx],
    nextId: list[idx + 1]?.id ?? null,
    position: idx + 1,
    total: list.length,
    history: db.prepare('SELECT answer_text, word_accuracy, exact_match, created_at FROM review_practice WHERE review_item_id = ? ORDER BY id DESC LIMIT 5')
      .all(item.id),
    pasteException: Boolean(db.prepare('SELECT cp_paste_exception FROM users WHERE id = ?').pluck().get(studentId)),
  };
}

export function practiceAudioPath(ctx, { studentId, reviewItemId }) {
  const item = loadPracticeItem(ctx.db, studentId, reviewItemId);
  return ctx.db.prepare('SELECT clip_path FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
}

/** Score one practice try and reveal the transcript with word-level feedback. */
export function checkPractice(ctx, { studentId, reviewItemId, text }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const item = loadPracticeItem(db, studentId, reviewItemId);
    const answer = cleanText(text);
    const transcript = db.prepare('SELECT transcript FROM audio_segments WHERE id = ?').pluck().get(item.segment_id);
    const score = scoreAnswer(transcript, answer);
    const now = clock.now();
    db.prepare('INSERT INTO review_practice (review_item_id, student_id, answer_text, word_accuracy, exact_match, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, studentId, answer, score.wordAccuracy, score.exact ? 1 : 0, now);
    logEvent(db, now, {
      studentId, testId: item.test_id, itemId: item.test_item_id, reviewItemId: item.id, type: 'practice_checked',
      metadata: { wordAccuracy: score.wordAccuracy, exact: score.exact },
    });
    return { transcript, answer, ...scoreView(score) };
  });
}
