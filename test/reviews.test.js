import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { HOUR } from '../src/lib/time.js';
import { reviewQueue } from '../src/services/reviews.js';
import { boot, itemPlayUrl, playFull, publishTest, runDelayed, runReview, start, transcriptFor } from './helpers.js';

/** Submit a test with every answer wrong except those whose index is in `correct`. */
async function submitWithErrors(w, client, testId, correct = []) {
  const { attemptId, sessionId, state } = await start(client, testId);
  for (let i = 0; i < state.attempt.itemCount; i++) {
    const st = await client.get(`/api/cp/attempts/${attemptId}`);
    await playFull(w, client, itemPlayUrl(attemptId, st.data.item.id), sessionId);
    const text = correct.includes(i) ? transcriptFor(w, st.data.item.id) : `wrong answer ${i}`;
    await client.post(`/api/cp/attempts/${attemptId}/items/${st.data.item.id}/submit`, { sessionId, text });
  }
  return attemptId;
}

const segTranscript = (w, reviewItemId) => w.db.prepare(
  'SELECT s.transcript FROM review_items ri JOIN audio_segments s ON s.id = ri.segment_id WHERE ri.id = ?'
).pluck().get(reviewItemId);

describe('immediate review, delayed review and remediation', () => {
  let w;
  let testId;
  before(async () => {
    w = await boot();
    ({ testId } = await publishTest(w));
  });
  after(() => w.close());

  test('req 10: incorrect submissions (and only those) create Immediate Reviews', async () => {
    const attemptId = await submitWithErrors(w, w.s1, testId, [0, 1]);
    const items = w.db.prepare('SELECT * FROM review_items WHERE student_id = ?').all(w.users.s1);
    assert.equal(items.length, 8);
    assert.ok(items.every((i) => i.status === 'immediate_pending'));
    const tests = await w.s1.get('/api/cp/tests');
    assert.equal(tests.data.tests.find((t) => t.id === testId).status, 'review_required');
    assert.ok(attemptId);
  });

  test('req 11 / 12: the four stages preserve the original answer and schedule delayed review 48h later', async () => {
    const item = w.db.prepare('SELECT * FROM review_items WHERE student_id = ? ORDER BY id').get(w.users.s1);
    const original = w.db.prepare('SELECT answer_text FROM submitted_answers WHERE item_attempt_id = ?').pluck().get(item.source_item_attempt_id);
    const st = await w.s1.post(`/api/cp/reviews/${item.id}/start`, {});
    const { reviewAttemptId: ra, sessionId } = st.data;
    const base = `/api/cp/review-attempts/${ra}`;

    // Stage A: original answer shown, transcript hidden, three listens.
    let s = (await w.s1.get(base)).data;
    assert.equal(s.attempt.stage, 'self_correction');
    assert.equal(s.promptAnswer, original);
    assert.equal(s.plays.allowed, 3);
    assert.equal(JSON.stringify(s).includes(segTranscript(w, item.id)), false);
    for (let i = 0; i < 3; i++) await playFull(w, w.s1, `${base}/play`, sessionId);
    assert.equal((await w.s1.post(`${base}/play`, { sessionId })).status, 403);
    await w.s1.post(`${base}/self-correction`, { sessionId, text: 'fixture sentence number' });

    // Stage B: feedback with transcript and word-level differences.
    s = (await w.s1.get(base)).data;
    assert.equal(s.attempt.stage, 'feedback');
    assert.equal(s.transcript, segTranscript(w, item.id));
    assert.equal(s.original.text, original);
    assert.equal(s.revised.text, 'fixture sentence number');
    assert.ok(Array.isArray(s.revised.missing) && s.revised.missing.length === 1);

    // Stage C: guided listening allows seekable audio and two full replays.
    await w.s1.post(`${base}/advance`, { sessionId, from: 'feedback' });
    s = (await w.s1.get(base)).data;
    assert.equal(s.attempt.stage, 'guided');
    const guided = await w.s1.get(`${base}/guided-audio`, { Range: 'bytes=0-99' });
    assert.equal(guided.status, 206, 'seeking is allowed in guided listening');
    assert.equal(s.plays.allowed, 2);

    // Stage D: transcript hidden again, one play, recall saved separately.
    await w.s1.post(`${base}/advance`, { sessionId, from: 'guided' });
    s = (await w.s1.get(base)).data;
    assert.equal(s.attempt.stage, 'final_recall');
    assert.equal(s.transcript, undefined);
    assert.equal((await w.s1.get(`${base}/guided-audio`)).status, 403);
    assert.equal((await w.s1.post(`${base}/final-recall`, { sessionId, text: 'x' })).data.error.code, 'WRITING_LOCKED');
    await playFull(w, w.s1, `${base}/play`, sessionId);
    assert.equal((await w.s1.post(`${base}/play`, { sessionId })).status, 403, 'final recall plays once');
    const now = w.clock.now();
    const done = await w.s1.post(`${base}/final-recall`, { sessionId, text: 'not perfect' });
    assert.equal(done.status, 200, 'completion does not require 100% correctness');
    assert.equal(done.data.delayedDueAt, now + 48 * HOUR);

    const after = w.db.prepare('SELECT * FROM review_items WHERE id = ?').get(item.id);
    assert.equal(after.status, 'awaiting_delayed');
    assert.equal(after.delayed_due_at, after.immediate_completed_at + 48 * HOUR);
    assert.equal(w.db.prepare('SELECT answer_text FROM submitted_answers WHERE item_attempt_id = ?').pluck().get(item.source_item_attempt_id), original);
    const ra2 = w.db.prepare('SELECT * FROM review_attempts WHERE id = ?').get(ra);
    assert.equal(ra2.self_correction_text, 'fixture sentence number');
    assert.equal(ra2.final_recall_text, 'not perfect');
    const types = w.db.prepare('SELECT event_type FROM activity_events WHERE review_item_id = ?').pluck().all(item.id);
    assert.ok(types.includes('immediate_review_started') && types.includes('immediate_review_completed'));
  });

  test('req 13: delayed review is not available early and uses the strict two-play policy without hints', async () => {
    const item = w.db.prepare("SELECT * FROM review_items WHERE student_id = ? AND status = 'awaiting_delayed'").get(w.users.s1);
    const early = await w.s1.post(`/api/cp/reviews/${item.id}/start`, {});
    assert.equal(early.status, 403);
    w.clock.advance(48 * HOUR);
    const st = await w.s1.post(`/api/cp/reviews/${item.id}/start`, {});
    const base = `/api/cp/review-attempts/${st.data.reviewAttemptId}`;
    const sessionId = st.data.sessionId;
    const s = (await w.s1.get(base)).data;
    assert.equal(s.attempt.stage, 'listening');
    assert.equal(s.plays.allowed, 2);
    assert.equal(s.canWrite, false);
    const json = JSON.stringify(s);
    assert.equal(json.includes(segTranscript(w, item.id)), false);
    assert.equal(s.promptAnswer, undefined, 'earlier answers are hidden');
    assert.equal((await w.s1.post(`${base}/draft`, { sessionId, text: 'a' })).data.error.code, 'WRITING_LOCKED');
    await playFull(w, w.s1, `${base}/play`, sessionId);
    await playFull(w, w.s1, `${base}/play`, sessionId);
    assert.equal((await w.s1.post(`${base}/play`, { sessionId })).data.error.code, 'PLAY_LIMIT');
    const clipHeaders = await w.s1.post(`${base}/play`, { sessionId });
    assert.equal(clipHeaders.status, 403);
    // req 14: an incorrect delayed review opens remediation.
    const r = await w.s1.post(`${base}/delayed-submit`, { sessionId, text: 'still wrong' });
    assert.equal(r.data.result, 'failed');
    const after = w.db.prepare('SELECT * FROM review_items WHERE id = ?').get(item.id);
    assert.equal(after.status, 'remediation_pending');
    assert.equal(after.consecutive_failures, 1);
    assert.equal(after.teacher_attention, 0);
  });

  test('req 14 / 15: remediation shows the delayed answer, reschedules, and two failures set Teacher Attention', async () => {
    const item = w.db.prepare("SELECT * FROM review_items WHERE student_id = ? AND status = 'remediation_pending'").get(w.users.s1);
    const st = await w.s1.post(`/api/cp/reviews/${item.id}/start`, {});
    const s = (await w.s1.get(`/api/cp/review-attempts/${st.data.reviewAttemptId}`)).data;
    assert.equal(s.attempt.kind, 'remediation');
    assert.equal(s.promptAnswer, 'still wrong');
    // finish remediation via the shared flow
    const base = `/api/cp/review-attempts/${st.data.reviewAttemptId}`;
    const sessionId = st.data.sessionId;
    await w.s1.post(`${base}/self-correction`, { sessionId, text: 'x' });
    await w.s1.post(`${base}/advance`, { sessionId, from: 'feedback' });
    await w.s1.post(`${base}/advance`, { sessionId, from: 'guided' });
    await playFull(w, w.s1, `${base}/play`, sessionId);
    const done = await w.s1.post(`${base}/final-recall`, { sessionId, text: 'x' });
    assert.equal(done.data.delayedDueAt, w.clock.now() + 48 * HOUR);
    assert.ok(w.db.prepare("SELECT 1 FROM activity_events WHERE review_item_id = ? AND event_type = 'remediation_completed'").get(item.id));

    w.clock.advance(48 * HOUR);
    const second = await runDelayed(w, w.s1, item.id, 'wrong again');
    assert.equal(second.data.result, 'failed');
    const flagged = w.db.prepare('SELECT * FROM review_items WHERE id = ?').get(item.id);
    assert.equal(flagged.teacher_attention, 1);
    assert.equal(flagged.consecutive_failures, 2);
    // After remediation the item waits for the teacher instead of looping automatically.
    await runReview(w, w.s1, item.id);
    assert.equal(w.db.prepare('SELECT status FROM review_items WHERE id = ?').pluck().get(item.id), 'teacher_hold');
    const queue = (await w.s1.get('/api/cp/queue')).data;
    assert.ok(queue.teacherAttention.some((q) => q.id === item.id));
    assert.ok(![...queue.dueToday, ...queue.overdue].some((q) => q.id === item.id));
    // Teacher dashboard highlights it, and the teacher can put it back with a support note.
    const mgmt = (await w.teacher.get('/api/teacher/reviews')).data.items;
    assert.ok(mgmt.some((m) => m.id === item.id && m.teacher_attention === 1));
    await w.teacher.post(`/api/teacher/review-items/${item.id}`, { action: 'support_note', note: 'Try the phrase-level exercise first.' });
    const res = await w.teacher.post(`/api/teacher/review-items/${item.id}`, { action: 'resolve' });
    assert.equal(res.data.status, 'awaiting_delayed');
    assert.equal(res.data.teacher_attention, 0);
  });

  test('a correct delayed review passes and becomes transfer-eligible', async () => {
    const item = w.db.prepare("SELECT * FROM review_items WHERE student_id = ? AND status = 'immediate_pending' ORDER BY id").get(w.users.s1);
    await runReview(w, w.s1, item.id);
    w.clock.advance(48 * HOUR);
    const r = await runDelayed(w, w.s1, item.id, segTranscript(w, item.id).toUpperCase() + '!');
    assert.equal(r.data.result, 'passed');
    const row = w.db.prepare('SELECT * FROM review_items WHERE id = ?').get(item.id);
    assert.equal(row.status, 'delayed_passed');
    assert.equal(row.transfer_eligible, 1);
    const q = (await w.s1.get('/api/cp/queue')).data;
    assert.ok(q.passed.some((p) => p.id === item.id));
  });
});

describe('review queue priority and daily cap', () => {
  test('req 16 / 17: oldest overdue first, repeated failures break ties, five mandatory per day, nothing discarded', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      await submitWithErrors(w, w.s2, testId, []);
      const ids = w.db.prepare('SELECT id FROM review_items WHERE student_id = ? ORDER BY id').pluck().all(w.users.s2);
      assert.equal(ids.length, 10);
      const now = w.clock.now();
      // Arrange due times directly: two share a due time, one of them with a prior failure.
      const set = w.db.prepare("UPDATE review_items SET status = 'awaiting_delayed', delayed_due_at = ?, consecutive_failures = ? WHERE id = ?");
      set.run(now - 72 * HOUR, 0, ids[0]);
      set.run(now - 96 * HOUR, 0, ids[1]); // oldest
      set.run(now - 72 * HOUR, 1, ids[2]); // same time as ids[0], repeated failure
      set.run(now - 1 * HOUR, 0, ids[3]);
      set.run(now - 2 * HOUR, 0, ids[4]);
      set.run(now - 3 * HOUR, 0, ids[5]);
      const before = w.db.prepare('SELECT id, delayed_due_at FROM review_items ORDER BY id').all();
      const q = reviewQueue({ db: w.db, clock: w.clock }, w.users.s2);
      const delayedOnly = (qq) => [...qq.overdue, ...qq.dueToday].filter((i) => i.kind === 'delayed');
      const order = delayedOnly(q).map((i) => i.id);
      assert.deepEqual(order.slice(0, 3), [ids[1], ids[2], ids[0]]);
      const all = delayedOnly(q);
      assert.equal(all.length, 6, 'overflow items are kept');
      assert.equal(all.filter((i) => i.mandatory).length, 5);
      assert.equal(all.find((i) => !i.mandatory).id, ids[3], 'newest due item is the overflow');
      // Overdue reviews cannot be started by the student; they are reported to the teacher instead.
      const blocked = await w.s2.post(`/api/cp/reviews/${ids[1]}/start`, {});
      assert.equal(blocked.data.error.code, 'OVERDUE');
      const report = (await w.teacher.get('/api/teacher/dashboard')).data.overdue;
      assert.ok(report.some((o) => o.type === 'review' && o.reviewItemId === ids[1]));
      // Completing a delayed review due today uses one of the five slots.
      await runDelayed(w, w.s2, ids[4], 'nope');
      const q2 = reviewQueue({ db: w.db, clock: w.clock }, w.users.s2);
      assert.equal(delayedOnly(q2).filter((i) => i.mandatory).length, 4);
      const afterRows = w.db.prepare('SELECT id, delayed_due_at FROM review_items ORDER BY id').all();
      assert.deepEqual(afterRows, before, 'presentation rules never change original due times');
      // Today's to-do list leaves overdue items out and is sorted by deadline.
      const today = (await w.s2.get('/api/cp/today')).data;
      assert.ok(!today.todo.some((t) => t.type === 'review' && [ids[0], ids[1], ids[2]].includes(t.id)));
      assert.ok(today.sentToTeacher >= 3);
      const deadlines = today.todo.map((t) => t.deadline ?? Infinity);
      assert.deepEqual(deadlines, [...deadlines].sort((a, b) => a - b));
    } finally { await w.close(); }
  });
});

describe('daily Guided Review limit and pending remediation queue', () => {
  test('ten wrong answers: five guided reviews today, five wait; none gets a delayed review early', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      await submitWithErrors(w, w.s1, testId, []);
      let q = (await w.s1.get('/api/cp/queue')).data;
      const todayImmediate = [...q.overdue, ...q.dueToday].filter((i) => i.kind === 'immediate');
      assert.equal(todayImmediate.length, 5);
      assert.equal(q.pendingRemediation.length, 5);
      assert.equal(q.guidedLimit, 5);
      // Pending items cannot be started today, even directly through the API.
      const blocked = await w.s1.post(`/api/cp/reviews/${q.pendingRemediation[0].id}/start`, {});
      assert.equal(blocked.status, 403);
      assert.equal(blocked.data.error.code, 'GUIDED_LIMIT_REACHED');
      // Feedback exists for every incorrect item: each one has a review item.
      assert.equal(w.db.prepare('SELECT COUNT(*) FROM review_items WHERE student_id = ?').pluck().get(w.users.s1), 10);
      for (const r of todayImmediate) await runReview(w, w.s1, r.id);
      q = (await w.s1.get('/api/cp/queue')).data;
      assert.equal(q.pendingRemediation.length, 5, 'starting five uses the whole daily limit');
      const waiting = w.db.prepare("SELECT delayed_due_at FROM review_items WHERE student_id = ? AND status = 'immediate_pending'").pluck().all(w.users.s1);
      assert.equal(waiting.length, 5);
      assert.ok(waiting.every((d) => d === null), 'no delayed review before guided review is done');
      // Guided reviews done today are due for delayed review 48h after each completion.
      const done = w.db.prepare("SELECT * FROM review_items WHERE student_id = ? AND status = 'awaiting_delayed'").all(w.users.s1);
      assert.ok(done.every((d) => d.delayed_due_at === d.immediate_completed_at + 48 * HOUR));
      // Next day the remaining five become available.
      w.clock.advance(24 * HOUR);
      q = (await w.s1.get('/api/cp/queue')).data;
      assert.equal(q.pendingRemediation.length, 0);
      assert.equal([...q.overdue, ...q.dueToday].filter((i) => i.kind === 'immediate').length, 5);
    } finally { await w.close(); }
  });

  test('the teacher can change the daily Guided Review limit', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      await submitWithErrors(w, w.s1, testId, []);
      const r = await w.teacher.patch('/api/teacher/settings', { daily_guided_review_limit: 7 });
      assert.equal(r.data.daily_guided_review_limit, 7);
      const q = (await w.s1.get('/api/cp/queue')).data;
      assert.equal(q.pendingRemediation.length, 3);
      assert.equal((await w.teacher.patch('/api/teacher/settings', { daily_guided_review_limit: 0 })).status, 400);
      assert.equal((await w.s1.patch('/api/teacher/settings', { daily_guided_review_limit: 9 })).status, 403);
    } finally { await w.close(); }
  });
});

describe('to-do list, overdue tests, redo and free practice', () => {
  test('Today is one list of tests and reviews; an overdue test leaves it and is reported', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      let t = (await w.s1.get('/api/cp/today')).data;
      assert.deepEqual(t.todo.map((x) => [x.type, x.id]), [['test', testId]]);
      w.clock.advance(24 * HOUR); // past the end of day 1
      t = (await w.s1.get('/api/cp/today')).data;
      assert.equal(t.todo.length, 0);
      assert.equal(t.sentToTeacher, 1);
      assert.equal((await w.s1.post(`/api/cp/tests/${testId}/start`, {})).data.error.code, 'OVERDUE');
      const d = (await w.teacher.get('/api/teacher/dashboard')).data;
      assert.equal(d.overdue.filter((o) => o.type === 'test').length, 3, 'one per assigned student');
    } finally { await w.close(); }
  });

  test('redo test: practice retake keeps the original answers and score untouched', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      assert.equal((await w.s1.post(`/api/cp/tests/${testId}/practice/start`, {})).data.error.code, 'FINISH_FIRST');
      const original = await submitWithErrors(w, w.s1, testId, [0, 1]);
      const before = w.db.prepare('SELECT answer_text, word_accuracy FROM submitted_answers WHERE attempt_id = ? ORDER BY id').all(original);
      const metricsBefore = (await w.s1.get('/api/cp/progress')).data;
      const p = await w.s1.post(`/api/cp/tests/${testId}/practice/start`, {});
      assert.equal(p.status, 200);
      assert.notEqual(p.data.attemptId, original);
      const { attemptId, sessionId } = p.data;
      let last;
      for (let i = 0; i < 10; i++) {
        const st = await w.s1.get(`/api/cp/attempts/${attemptId}`);
        assert.equal(st.data.attempt.kind, 'practice');
        await playFull(w, w.s1, itemPlayUrl(attemptId, st.data.item.id), sessionId);
        last = await w.s1.post(`/api/cp/attempts/${attemptId}/items/${st.data.item.id}/submit`, { sessionId, text: transcriptFor(w, st.data.item.id) });
      }
      assert.equal(last.data.summary.practice, true);
      assert.equal(last.data.summary.exactCount, 10);
      assert.equal(last.data.summary.original.exactCount, 2);
      // Original answers unchanged; independent metrics unchanged; practice counted separately.
      assert.deepEqual(w.db.prepare('SELECT answer_text, word_accuracy FROM submitted_answers WHERE attempt_id = ? ORDER BY id').all(original), before);
      const metricsAfter = (await w.s1.get('/api/cp/progress')).data;
      assert.deepEqual(metricsAfter.independent, metricsBefore.independent);
      assert.equal(metricsAfter.practice.retakes, 1);
      assert.equal(w.db.prepare('SELECT COUNT(*) FROM review_items WHERE student_id = ?').pluck().get(w.users.s1), 8, 'retake creates no new reviews');
      // A second retake is allowed.
      assert.equal((await w.s1.post(`/api/cp/tests/${testId}/practice/start`, {})).status, 200);
    } finally { await w.close(); }
  });

  test('free practice: only after guided review, unlimited, never changes the review schedule', async () => {
    const w = await boot();
    try {
      const { testId } = await publishTest(w);
      await submitWithErrors(w, w.s1, testId, []);
      const item = w.db.prepare('SELECT * FROM review_items WHERE student_id = ? ORDER BY id').get(w.users.s1);
      assert.equal((await w.s1.post(`/api/cp/practice/${item.id}/check`, { text: 'x' })).data.error.code, 'REVIEW_FIRST');
      await runReview(w, w.s1, item.id);
      const due = w.db.prepare('SELECT status, delayed_due_at FROM review_items WHERE id = ?').get(item.id);
      const list = (await w.s1.get('/api/cp/practice')).data.items;
      assert.deepEqual(list.map((x) => x.id), [item.id]);
      assert.equal((await w.s1.get(`/api/cp/practice/${item.id}/audio`, { Range: 'bytes=0-10' })).status, 206);
      const wrong = (await w.s1.post(`/api/cp/practice/${item.id}/check`, { text: 'nope' })).data;
      assert.equal(wrong.exact, false);
      assert.ok(wrong.transcript);
      const right = (await w.s1.post(`/api/cp/practice/${item.id}/check`, { text: wrong.transcript })).data;
      assert.equal(right.exact, true);
      assert.deepEqual(w.db.prepare('SELECT status, delayed_due_at FROM review_items WHERE id = ?').get(item.id), due);
      assert.equal((await w.s1.get(`/api/cp/practice/${item.id}`)).data.history.length, 2);
    } finally { await w.close(); }
  });
});
