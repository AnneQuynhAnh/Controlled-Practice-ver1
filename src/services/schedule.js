import { tx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { addDays, dayStart, DAY, localDate } from '../lib/time.js';
import { logTeacherAction } from './activity.js';

export const INITIAL_TEST_COUNT = 10;

/** Default fourteen-day plan. Test numbers refer to daily tests; day 14 hosts the "final" test. */
export const PLAN = [
  { day: 1, type: 'test', testNumber: 1 },
  { day: 2, type: 'test', testNumber: 2 },
  { day: 3, type: 'test', testNumber: 3 },
  { day: 4, type: 'test', testNumber: 4 },
  { day: 5, type: 'test', testNumber: 5 },
  { day: 6, type: 'review', label: 'Review and catch-up' },
  { day: 7, type: 'rest', label: 'Rest or overdue review' },
  { day: 8, type: 'test', testNumber: 6 },
  { day: 9, type: 'test', testNumber: 7 },
  { day: 10, type: 'test', testNumber: 8 },
  { day: 11, type: 'test', testNumber: 9 },
  { day: 12, type: 'test', testNumber: 10 },
  { day: 13, type: 'review', label: 'Review and catch-up' },
  { day: 14, type: 'final', label: 'Final unseen-audio assessment' },
];

const dayForTest = (number) => PLAN.find((p) => p.testNumber === number)?.day ?? null;

/** Create the ten initial Daily Test shells (no content) on first boot. */
export function ensureInitialTests(db, now) {
  if (db.prepare('SELECT COUNT(*) FROM tests').pluck().get() > 0) return 0;
  const insert = db.prepare(
    `INSERT INTO tests (number, kind, title, mode, plan_day, created_at, updated_at) VALUES (?, 'daily', ?, 'training', ?, ?, ?)`
  );
  db.transaction(() => {
    for (let n = 1; n <= INITIAL_TEST_COUNT; n++) {
      insert.run(n, `Daily Test ${String(n).padStart(2, '0')}`, dayForTest(n), now, now);
    }
  })();
  db.prepare('INSERT OR IGNORE INTO schedule_plans (id, start_date, updated_at) VALUES (1, NULL, ?)').run(now);
  return INITIAL_TEST_COUNT;
}

export function getPlan(db) {
  const row = db.prepare('SELECT * FROM schedule_plans WHERE id = 1').get();
  const startDate = row?.start_date ?? null;
  return {
    startDate,
    timezone: row?.timezone ?? 'Asia/Ho_Chi_Minh',
    days: PLAN.map((p) => ({ ...p, date: startDate ? addDays(startDate, p.day - 1) : null })),
  };
}

/** Which plan day "now" falls on, if the plan has started and not ended. */
export function currentPlanDay(db, now) {
  const { startDate, days } = getPlan(db);
  if (!startDate) return null;
  const today = localDate(now);
  return days.find((d) => d.date === today) ?? null;
}

/**
 * Apply the plan from a teacher-chosen start date: each test releases at 00:00 on its plan day and is
 * due at 23:59:59.999 that day (Asia/Ho_Chi_Minh). Teachers can edit individual dates afterwards.
 */
export function applySchedule(ctx, { teacherId, startDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw badRequest('INVALID_DATE', 'Choose a start date (YYYY-MM-DD).');
  dayStart(startDate);
  const { db, clock } = ctx;
  return tx(db, () => {
    const now = clock.now();
    db.prepare(
      `INSERT INTO schedule_plans (id, start_date, updated_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET start_date = excluded.start_date, updated_at = excluded.updated_at`
    ).run(startDate, now);
    const tests = db.prepare("SELECT * FROM tests WHERE status != 'archived'").all();
    const updated = [];
    for (const t of tests) {
      const day = t.kind === 'final' ? 14 : t.number <= INITIAL_TEST_COUNT ? dayForTest(t.number) : null;
      if (!day) continue;
      const date = addDays(startDate, day - 1);
      const releaseAt = dayStart(date);
      const dueAt = releaseAt + DAY - 1;
      db.prepare('UPDATE tests SET plan_day = ?, release_at = ?, due_at = ?, updated_at = ? WHERE id = ?').run(day, releaseAt, dueAt, now, t.id);
      updated.push({ testId: t.id, day, date });
    }
    logTeacherAction(db, now, { teacherId, action: 'apply_schedule', targetType: 'schedule_plan', targetId: 1, metadata: { startDate, updated } });
    return { ...getPlan(db), updated };
  });
}
