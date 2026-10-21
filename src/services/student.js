import { dayStart, localDate } from '../lib/time.js';
import { testWindow } from './assessment.js';
import { currentPlanDay } from './schedule.js';
import { reviewQueue } from './reviews.js';

/**
 * Card status for one student and test:
 * locked | available | in_progress | overdue | review_required | submitted | completed
 */
export function testStatus({ test, assignment, attempt, reviewStatuses, now }) {
  const { releaseAt, dueAt } = testWindow(test, assignment ?? {});
  if (attempt?.status === 'submitted') {
    if (reviewStatuses.some((s) => s === 'immediate_pending' || s === 'immediate_in_progress')) return 'review_required';
    if (reviewStatuses.some((s) => !['delayed_passed', 'closed_by_teacher'].includes(s))) return 'submitted';
    return 'completed';
  }
  if (!assignment || test.status !== 'published' || releaseAt == null || now < releaseAt) return 'locked';
  if (attempt) return 'in_progress';
  if (dueAt != null && now > dueAt) return 'overdue';
  return 'available';
}

export function listStudentTests(ctx, studentId) {
  const { db, clock } = ctx;
  const now = clock.now();
  const tests = db.prepare("SELECT * FROM tests WHERE status != 'archived' ORDER BY kind = 'final', number").all();
  return tests.map((test) => {
    const assignment = db.prepare('SELECT * FROM student_assignments WHERE test_id = ? AND student_id = ?').get(test.id, studentId);
    const attempt = db.prepare(
      "SELECT * FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'independent'"
    ).get(test.id, studentId);
    const practice = db.prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'submitted') AS done, MAX(CASE WHEN status = 'in_progress' THEN id END) AS open
         FROM assessment_attempts WHERE test_id = ? AND student_id = ? AND attempt_kind = 'practice'`
    ).get(test.id, studentId);
    const reviewStatuses = db.prepare('SELECT status FROM review_items WHERE test_id = ? AND student_id = ?').pluck().all(test.id, studentId);
    const { releaseAt, dueAt } = testWindow(test, assignment);
    const itemCount = db.prepare('SELECT COUNT(*) FROM test_items WHERE test_id = ?').pluck().get(test.id);
    const visible = Boolean(assignment && test.status === 'published');
    return {
      id: test.id, number: test.number, kind: test.kind, title: test.title,
      mode: visible ? test.mode : null,
      releaseAt: visible ? releaseAt : test.release_at, dueAt: visible ? dueAt : test.due_at,
      planDay: test.plan_day, itemCount,
      status: testStatus({ test, assignment, attempt, reviewStatuses, now }),
      attemptId: attempt?.id ?? null,
      progress: attempt ? { position: attempt.status === 'submitted' ? attempt.item_count : attempt.current_position - 1, total: attempt.item_count } : null,
      submittedAt: attempt?.submitted_at ?? null,
      practice: { retakes: practice.done, inProgress: Boolean(practice.open) },
    };
  });
}

/**
 * Today as one to-do list: tests and reviews together, soonest deadline first.
 * Anything past its deadline is left out (the teacher sees it on the dashboard instead).
 * A test already in progress stays until it is finished.
 */
export function todayOverview(ctx, studentId) {
  const { db, clock } = ctx;
  const now = clock.now();
  const today = localDate(now);
  const tests = listStudentTests(ctx, studentId);
  const queue = reviewQueue(ctx, studentId);
  const testTodos = tests
    .filter((t) => t.status === 'available' || t.status === 'in_progress')
    .map((t) => ({
      type: 'test', id: t.id, title: t.title, mode: t.mode, itemCount: t.itemCount, deadline: t.dueAt,
      status: t.status, progress: t.progress, late: t.dueAt != null && t.dueAt < now,
    }));
  const reviewTodos = [...queue.dueToday, ...queue.overdue]
    .filter((r) => !r.overdue && r.mandatory !== false)
    .map((r) => ({
      type: 'review', id: r.id, kind: r.kind, title: `${r.testTitle} · Sentence ${r.sentence}`, deadline: r.deadline,
      status: r.status, cycles: r.cycles, teacherAttention: r.teacherAttention, supportNote: r.supportNote,
    }));
  const todo = [...testTodos, ...reviewTodos].sort((a, b) =>
    (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || (a.type === b.type ? 0 : a.type === 'review' ? -1 : 1));

  const overdueTests = tests.filter((t) => t.status === 'overdue').length;
  const upcoming = tests.filter((t) => t.status === 'locked' && t.releaseAt && t.releaseAt > now && t.mode)
    .sort((a, b) => a.releaseAt - b.releaseAt).slice(0, 3);
  return {
    today,
    todayStart: dayStart(today),
    planDay: currentPlanDay(db, now),
    todo,
    sentToTeacher: overdueTests + queue.overdue.length,
    waitingForLater: queue.pendingRemediation.length,
    guidedLimit: queue.guidedLimit,
    dailyCap: queue.dailyCap,
    upcoming,
  };
}
