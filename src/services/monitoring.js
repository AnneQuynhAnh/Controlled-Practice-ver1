import { tx } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dayStart, localDate } from '../lib/time.js';
import { logTeacherAction } from './activity.js';
import { DELAYED_REVIEW_INTERVAL_MS, delayedDeadline, guidedReviewPlan } from './reviews.js';
import { listStudentTests } from './student.js';
import { studentMetrics } from './metrics.js';
import { currentPlanDay } from './schedule.js';
import { getSettings } from './settings.js';

const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

/**
 * Activity patterns worth a teacher's look. These are prompts for a conversation, not conclusions:
 * the browser cannot tell whether a student was listening or why they left the tab.
 */
export function integrityFlags(db, attemptId) {
  const events = db.prepare('SELECT event_type, metadata FROM activity_events WHERE attempt_id = ?').all(attemptId);
  const count = (t) => events.filter((e) => e.event_type === t).length;
  const flags = [];
  const hidden = count('tab_hidden');
  if (hidden >= 3) flags.push({ code: 'tab_exits', label: `Left the test tab ${hidden} times` });
  const pastes = count('paste_attempt');
  if (pastes >= 1) flags.push({ code: 'paste_attempts', label: `${pastes} paste attempt${pastes > 1 ? 's' : ''} blocked` });
  const copies = count('copy_attempt');
  if (copies >= 1) flags.push({ code: 'copy_attempts', label: `${copies} copy attempt${copies > 1 ? 's' : ''} blocked` });
  const interrupts = events.filter((e) => e.event_type === 'audio_play_interrupted' && parse(e.metadata).reason !== 'stage_advanced').length;
  if (interrupts >= 2) flags.push({ code: 'interruptions', label: `${interrupts} interrupted listens` });
  const concurrent = count('concurrent_session_detected');
  if (concurrent) flags.push({ code: 'concurrent_sessions', label: `Opened in ${concurrent + 1} tabs or devices at once` });
  const fast = events.filter((e) => {
    if (e.event_type !== 'answer_submitted') return false;
    const m = parse(e.metadata);
    return m.words >= 6 && m.msSincePlayCompleted != null && m.msSincePlayCompleted < 4000;
  }).length;
  if (fast) flags.push({ code: 'unusual_timing', label: `${fast} long answer${fast > 1 ? 's' : ''} submitted under 4s after listening` });
  return flags;
}

export function dashboard(ctx) {
  const { db, clock } = ctx;
  const now = clock.now();
  const today = localDate(now);
  const todayStart = dayStart(today);
  const students = db.prepare("SELECT id, display_name FROM users WHERE role = 'student' ORDER BY display_name").all();
  const todaysTests = db.prepare(
    "SELECT * FROM tests WHERE status = 'published' AND release_at >= ? AND release_at < ? ORDER BY number"
  ).all(todayStart, todayStart + 86_400_000);

  const rows = students.map((s) => {
    const tests = listStudentTests(ctx, s.id);
    const today = todaysTests.map((t) => {
      const card = tests.find((c) => c.id === t.id);
      return { testId: t.id, title: t.title, status: card?.status ?? 'not_assigned' };
    });
    const reviews = db.prepare('SELECT status, delayed_due_at, teacher_attention, postponed_until FROM review_items WHERE student_id = ?').all(s.id);
    const metrics = studentMetrics(db, s.id);
    const flagged = db.prepare('SELECT id FROM assessment_attempts WHERE student_id = ?').pluck().all(s.id)
      .filter((aid) => integrityFlags(db, aid).length).length;
    const guided = guidedReviewPlan(db, s.id, now);
    return {
      studentId: s.id,
      name: s.display_name,
      today,
      guidedToday: guided.today.size,
      pendingRemediation: guided.pending.size,
      incompleteImmediate: reviews.filter((r) => r.status === 'immediate_pending' || r.status === 'immediate_in_progress').length,
      overdueDelayed: reviews.filter((r) => r.status === 'awaiting_delayed' && r.delayed_due_at < todayStart).length,
      dueDelayed: reviews.filter((r) => r.status === 'awaiting_delayed' && r.delayed_due_at <= now).length,
      teacherAttention: reviews.filter((r) => r.teacher_attention).length,
      avgPlaysPerSentence: metrics.independent.avgPlaysPerSentence,
      secondPlayRate: metrics.independent.secondPlayRate,
      familiarAccuracy: metrics.familiarity.familiar.wordAccuracy,
      unseenAccuracy: metrics.familiarity.unseen.wordAccuracy,
      flaggedAttempts: flagged,
    };
  });

  const repeatedlyMissed = db.prepare(
    `SELECT s.id AS segment_id, s.transcript, a.title AS source_title,
            COUNT(DISTINCT ri.student_id) AS students_missed,
            SUM(ri.delayed_cycles - (ri.status = 'delayed_passed')) AS delayed_failures
       FROM review_items ri JOIN audio_segments s ON s.id = ri.segment_id JOIN audio_sources a ON a.id = s.audio_id
      GROUP BY s.id HAVING students_missed >= 2 OR delayed_failures >= 2
      ORDER BY students_missed DESC, delayed_failures DESC LIMIT 10`
  ).all();

  const flaggedAttempts = db.prepare(
    `SELECT a.id, a.test_id, a.student_id, a.submitted_at, a.status, t.title, u.display_name
       FROM assessment_attempts a JOIN tests t ON t.id = a.test_id JOIN users u ON u.id = a.student_id
      ORDER BY a.started_at DESC`
  ).all().map((a) => ({ ...a, flags: integrityFlags(db, a.id) })).filter((a) => a.flags.length).slice(0, 15);

  // Overdue work disappears from the student's to-do list and is reported here instead.
  const overdue = [];
  for (const s of students) {
    for (const t of listStudentTests(ctx, s.id)) {
      if (t.status === 'overdue') {
        const assignmentId = db.prepare('SELECT id FROM student_assignments WHERE test_id = ? AND student_id = ?').pluck().get(t.id, s.id);
        overdue.push({ type: 'test', studentId: s.id, name: s.display_name, title: t.title, deadline: t.dueAt, testId: t.id, assignmentId });
      }
    }
    db.prepare(
      `SELECT ri.*, t.title AS test_title, ia.position FROM review_items ri JOIN tests t ON t.id = ri.test_id
         JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id WHERE ri.student_id = ? AND ri.status = 'awaiting_delayed'`
    ).all(s.id).forEach((r) => {
      const deadline = delayedDeadline(r);
      if (deadline != null && deadline < now) {
        overdue.push({ type: 'review', studentId: s.id, name: s.display_name, title: `${r.test_title} · Sentence ${r.position}`, deadline, reviewItemId: r.id });
      }
    });
  }
  overdue.sort((a, b) => a.deadline - b.deadline);

  return {
    today,
    overdue,
    settings: getSettings(db),
    planDay: currentPlanDay(db, now),
    todaysTests: todaysTests.map((t) => ({ id: t.id, title: t.title, mode: t.mode })),
    students: rows,
    completionSummary: todaysTests.map((t) => ({
      testId: t.id, title: t.title,
      submitted: rows.filter((r) => r.today.find((x) => x.testId === t.id && ['submitted', 'review_required', 'completed'].includes(x.status))).length,
      inProgress: rows.filter((r) => r.today.find((x) => x.testId === t.id && x.status === 'in_progress')).length,
      notStarted: rows.filter((r) => r.today.find((x) => x.testId === t.id && ['available', 'overdue'].includes(x.status))).length,
      assigned: rows.filter((r) => r.today.find((x) => x.testId === t.id && x.status !== 'not_assigned')).length,
    })),
    repeatedlyMissed,
    // Familiar vs unseen gap of 20 points or more.
    transferGaps: rows.filter((r) => r.familiarAccuracy != null && r.unseenAccuracy != null && r.familiarAccuracy - r.unseenAccuracy >= 0.2)
      .map((r) => ({ studentId: r.studentId, name: r.name, familiar: r.familiarAccuracy, unseen: r.unseenAccuracy })),
    flaggedAttempts,
  };
}

export function analytics(ctx) {
  const { db } = ctx;
  return db.prepare("SELECT id, display_name FROM users WHERE role = 'student' ORDER BY display_name").all()
    .map((s) => ({ studentId: s.id, name: s.display_name, metrics: studentMetrics(db, s.id) }));
}

export function studentDetail(ctx, studentId) {
  const { db } = ctx;
  const student = db.prepare("SELECT id, username, display_name, cp_paste_exception FROM users WHERE id = ? AND role = 'student'").get(studentId);
  if (!student) throw notFound('Student not found.');
  const attempts = db.prepare(
    `SELECT a.*, t.title, t.number, t.mode FROM assessment_attempts a JOIN tests t ON t.id = a.test_id
      WHERE a.student_id = ? ORDER BY a.started_at DESC`
  ).all(studentId).map((a) => ({ ...a, flags: integrityFlags(db, a.id) }));
  return {
    student,
    metrics: studentMetrics(db, studentId),
    tests: listStudentTests(ctx, studentId),
    attempts,
    reviewItems: reviewItemsFor(db, { studentId }),
  };
}

function reviewItemsFor(db, { studentId = null, attentionOnly = false }) {
  return db.prepare(
    `SELECT ri.*, u.display_name, t.title AS test_title, t.number AS test_number, s.transcript, ia.position
       FROM review_items ri JOIN users u ON u.id = ri.student_id JOIN tests t ON t.id = ri.test_id
       JOIN audio_segments s ON s.id = ri.segment_id JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id
      WHERE (? IS NULL OR ri.student_id = ?) AND (? = 0 OR ri.teacher_attention = 1 OR ri.status = 'teacher_hold' OR ri.consecutive_failures >= 1)
      ORDER BY ri.teacher_attention DESC, ri.consecutive_failures DESC, ri.updated_at DESC`
  ).all(studentId, studentId, attentionOnly ? 1 : 0);
}

export function reviewManagement(ctx) {
  return reviewItemsFor(ctx.db, { attentionOnly: true }).map((r) => ({
    ...r,
    attempts: ctx.db.prepare('SELECT * FROM review_attempts WHERE review_item_id = ? ORDER BY id').all(r.id),
  }));
}

export function attemptDetail(ctx, attemptId) {
  const { db } = ctx;
  const attempt = db.prepare(
    `SELECT a.*, t.title, t.number, t.mode, u.display_name FROM assessment_attempts a
       JOIN tests t ON t.id = a.test_id JOIN users u ON u.id = a.student_id WHERE a.id = ?`
  ).get(attemptId);
  if (!attempt) throw notFound('Attempt not found.');
  const items = db.prepare(
    `SELECT ia.*, s.transcript, s.duration_ms, s.main_skill_tag, sa.answer_text, sa.couldnt_catch, sa.word_accuracy, sa.exact_match, sa.alignment_json, sa.submitted_at AS answer_submitted_at
       FROM item_attempts ia JOIN audio_segments s ON s.id = ia.segment_id
       LEFT JOIN submitted_answers sa ON sa.item_attempt_id = ia.id
      WHERE ia.attempt_id = ? ORDER BY ia.position`
  ).all(attemptId).map((ia) => {
    const review = db.prepare('SELECT * FROM review_items WHERE source_item_attempt_id = ?').get(ia.id);
    return {
      ...ia,
      alignment: ia.alignment_json ? JSON.parse(ia.alignment_json) : null,
      playback: db.prepare("SELECT * FROM playback_events WHERE owner_type = 'item_attempt' AND owner_id = ? ORDER BY id").all(ia.id),
      review: review && {
        ...review,
        attempts: db.prepare('SELECT * FROM review_attempts WHERE review_item_id = ? ORDER BY id').all(review.id).map((ra) => ({
          ...ra,
          playback: db.prepare("SELECT * FROM playback_events WHERE owner_type = 'review_attempt' AND owner_id = ? ORDER BY id").all(ra.id),
        })),
      },
    };
  });
  const reviewIds = items.map((i) => i.review?.id).filter(Boolean);
  const timeline = db.prepare(
    `SELECT * FROM activity_events WHERE attempt_id = ? ${reviewIds.length ? `OR review_item_id IN (${reviewIds.map(() => '?').join(',')})` : ''}
      ORDER BY server_ts, id`
  ).all(attemptId, ...reviewIds).map((e) => ({ ...e, metadata: parse(e.metadata) }));
  const restorations = db.prepare(
    "SELECT * FROM teacher_actions WHERE action = 'restore_play_credit' AND student_id = ? ORDER BY created_at"
  ).all(attempt.student_id).filter((r) => parse(r.metadata).attemptId === attempt.id);
  return { attempt, items, timeline, flags: integrityFlags(db, attemptId), restorations };
}

/** Teacher-authorized recovery after a technical failure. A reason is mandatory and recorded. */
export function restorePlayCredit(ctx, { teacherId, ownerType, ownerId, reason }) {
  const { db, clock } = ctx;
  if (!String(reason ?? '').trim()) throw badRequest('REASON_REQUIRED', 'Record why this listen is being restored.');
  return tx(db, () => {
    const now = clock.now();
    if (ownerType === 'item_attempt') {
      const ia = db.prepare(
        'SELECT ia.*, a.status AS attempt_status, a.student_id FROM item_attempts ia JOIN assessment_attempts a ON a.id = ia.attempt_id WHERE ia.id = ?'
      ).get(ownerId);
      if (!ia) throw notFound();
      if (ia.status === 'submitted' || ia.attempt_status !== 'in_progress') throw conflict('ALREADY_SUBMITTED', 'This sentence is already submitted.');
      db.prepare('UPDATE item_attempts SET credits_restored = credits_restored + 1 WHERE id = ?').run(ownerId);
      logTeacherAction(db, now, { teacherId, action: 'restore_play_credit', targetType: 'item_attempt', targetId: ownerId, studentId: ia.student_id, reason: String(reason).trim(), metadata: { attemptId: ia.attempt_id } });
    } else if (ownerType === 'review_attempt') {
      const ra = db.prepare('SELECT ra.*, ri.student_id FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id WHERE ra.id = ?').get(ownerId);
      if (!ra) throw notFound();
      if (ra.kind !== 'delayed' || ra.completed_at) throw conflict('NOT_RESTORABLE', 'Only an open delayed review can have a listen restored.');
      db.prepare('UPDATE review_attempts SET credits_restored = credits_restored + 1 WHERE id = ?').run(ownerId);
      logTeacherAction(db, now, { teacherId, action: 'restore_play_credit', targetType: 'review_attempt', targetId: ownerId, studentId: ra.student_id, reason: String(reason).trim() });
    } else {
      throw badRequest('INVALID_TARGET', 'Unknown target.');
    }
    return { ok: true };
  });
}

/** Open items with interrupted listens and no remaining credits: candidates for restoration. */
export function recoveryQueue(ctx) {
  const { db } = ctx;
  const items = db.prepare(
    `SELECT ia.id, ia.position, ia.playback_start_count, ia.playback_completed_count, ia.playback_interruption_count, ia.credits_restored,
            a.id AS attempt_id, t.title, u.display_name
       FROM item_attempts ia JOIN assessment_attempts a ON a.id = ia.attempt_id JOIN tests t ON t.id = a.test_id JOIN users u ON u.id = a.student_id
      WHERE a.status = 'in_progress' AND ia.status != 'submitted' AND ia.playback_interruption_count > 0`
  ).all();
  const reviews = db.prepare(
    `SELECT ra.id, ra.credits_restored, t.title, u.display_name, ia.position,
            (SELECT COUNT(*) FROM playback_events p WHERE p.owner_type = 'review_attempt' AND p.owner_id = ra.id AND p.status = 'interrupted') AS interruptions,
            (SELECT COUNT(*) FROM playback_events p WHERE p.owner_type = 'review_attempt' AND p.owner_id = ra.id) AS starts
       FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id JOIN tests t ON t.id = ri.test_id
       JOIN users u ON u.id = ri.student_id JOIN item_attempts ia ON ia.id = ri.source_item_attempt_id
      WHERE ra.kind = 'delayed' AND ra.completed_at IS NULL`
  ).all().filter((r) => r.interruptions > 0);
  return { items, reviews };
}

export function updateReviewItem(ctx, { teacherId, reviewItemId, action, note, postponeUntil, dueAt, reason = '' }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const now = clock.now();
    const item = db.prepare('SELECT * FROM review_items WHERE id = ?').get(reviewItemId);
    if (!item) throw notFound('Review item not found.');
    switch (action) {
      case 'support_note':
        db.prepare('UPDATE review_items SET support_note = ?, updated_at = ? WHERE id = ?').run(String(note ?? '').slice(0, 1000), now, item.id);
        break;
      case 'postpone': {
        const until = Number(postponeUntil);
        if (!Number.isFinite(until) || until <= now) throw badRequest('INVALID_DATE', 'Choose a future date.');
        // Presentation only: the original delayed_due_at is preserved.
        db.prepare('UPDATE review_items SET postponed_until = ?, updated_at = ? WHERE id = ?').run(until, now, item.id);
        break;
      }
      case 'resolve': {
        const due = dueAt == null || dueAt === '' ? now + DELAYED_REVIEW_INTERVAL_MS : Number(dueAt);
        if (!Number.isFinite(due)) throw badRequest('INVALID_DATE', 'Invalid due date.');
        // A held item goes back into the cycle; an item mid-remediation keeps its current step.
        const onHold = item.status === 'teacher_hold';
        db.prepare(
          'UPDATE review_items SET teacher_attention = 0, consecutive_failures = 0, status = ?, delayed_due_at = ?, updated_at = ? WHERE id = ?'
        ).run(onHold ? 'awaiting_delayed' : item.status, onHold ? due : item.delayed_due_at, now, item.id);
        break;
      }
      case 'close':
        db.prepare("UPDATE review_items SET status = 'closed_by_teacher', teacher_attention = 0, updated_at = ? WHERE id = ?").run(now, item.id);
        break;
      default:
        throw badRequest('INVALID_ACTION', 'Unknown action.');
    }
    logTeacherAction(db, now, { teacherId, action: `review_${action}`, targetType: 'review_item', targetId: item.id, studentId: item.student_id, reason, metadata: { note, postponeUntil, dueAt } });
    return db.prepare('SELECT * FROM review_items WHERE id = ?').get(item.id);
  });
}

export function setPasteException(ctx, { teacherId, studentId, allowed, reason = '' }) {
  const { db, clock } = ctx;
  const r = db.prepare("UPDATE users SET cp_paste_exception = ? WHERE id = ? AND role = 'student'").run(allowed ? 1 : 0, studentId);
  if (!r.changes) throw notFound('Student not found.');
  logTeacherAction(db, clock.now(), { teacherId, action: 'paste_exception', targetType: 'user', targetId: studentId, studentId, reason, metadata: { allowed: Boolean(allowed) } });
  return { allowed: Boolean(allowed) };
}
