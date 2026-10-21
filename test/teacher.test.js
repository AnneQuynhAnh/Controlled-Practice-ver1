import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DAY, dayStart } from '../src/lib/time.js';
import { boot, Client, publishTest, START_DATE, start, uploadTone } from './helpers.js';

test('req 22: role-based access is enforced', async () => {
  const w = await boot();
  try {
    const anon = new Client(w.base);
    assert.equal((await anon.get('/api/cp/today')).status, 401);
    assert.equal((await anon.get('/api/teacher/dashboard')).status, 401);
    assert.equal((await w.s1.get('/api/teacher/dashboard')).status, 403);
    assert.equal((await w.s1.post('/api/teacher/tests', { title: 'x' })).status, 403);
    assert.equal((await w.teacher.get('/api/cp/today')).status, 403);
    assert.equal((await w.teacher.get('/api/teacher/dashboard')).status, 200);
    // Mutations without the client header are refused (CSRF guard).
    const r = await fetch(`${w.base}/api/teacher/tests`, { method: 'POST', headers: { cookie: w.teacher.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    // A student cannot read another student's attempt.
    const { testId } = await publishTest(w);
    const { attemptId } = await start(w.s1, testId);
    assert.equal((await w.s2.get(`/api/cp/attempts/${attemptId}`)).status, 404);
  } finally { await w.close(); }
});

test('req 25: the ten initial tests exist and the 14-day plan schedules and assigns them', async () => {
  const w = await boot();
  try {
    const tests = (await w.teacher.get('/api/teacher/tests')).data.tests;
    assert.equal(tests.filter((t) => t.kind === 'daily').length, 10);
    const final = (await w.teacher.post('/api/teacher/tests', { kind: 'final' })).data;
    assert.equal(final.mode, 'transfer');
    const plan = (await w.teacher.post('/api/teacher/schedule', { startDate: START_DATE })).data;
    assert.equal(plan.updated.length, 11);
    const byNumber = Object.fromEntries((await w.teacher.get('/api/teacher/tests')).data.tests.filter((t) => t.kind === 'daily').map((t) => [t.number, t]));
    const expectDay = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 8, 7: 9, 8: 10, 9: 11, 10: 12 };
    for (const [n, day] of Object.entries(expectDay)) {
      assert.equal(byNumber[n].plan_day, day);
      assert.equal(byNumber[n].release_at, dayStart(START_DATE) + (day - 1) * DAY, `test ${n} releases at 00:00 ICT on day ${day}`);
      assert.equal(byNumber[n].due_at, byNumber[n].release_at + DAY - 1);
    }
    const finalRow = (await w.teacher.get(`/api/teacher/tests/${final.id}`)).data;
    assert.equal(finalRow.plan_day, 14);
    // 00:00 ICT is 17:00 UTC the previous day.
    assert.equal(new Date(byNumber[1].release_at).toISOString(), '2026-11-01T17:00:00.000Z');
    const ids = Object.values(byNumber).map((t) => t.id);
    const students = [w.users.s1, w.users.s2, w.users.s3];
    const asg = await w.teacher.post('/api/teacher/assignments', { testIds: ids, studentIds: students });
    assert.equal(asg.data.created, 30);
    const cards = (await w.s1.get('/api/cp/tests')).data.tests;
    assert.equal(cards.filter((c) => c.kind === 'daily').length, 10);
    assert.ok(cards.every((c) => c.status === 'locked'), 'unpublished tests are locked');
    assert.equal(plan.days.find((d) => d.day === 6).type, 'review');
    assert.equal(plan.days.find((d) => d.day === 7).type, 'rest');
  } finally { await w.close(); }
});

test('req 23 (server): Recovery, Training and Transfer expose different pre-listening scaffolding', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w, { mode: 'training', extra: { patch: { vocab: ['timetable', 'reception'] } } });
    const read = async () => (await start(w.s1, testId)).state.test.prelistening;
    let pre = await read();
    assert.deepEqual(pre, { mode: 'training', topic: null, situation: 'Fixture situation', vocab: ['timetable', 'reception'] });
    // Vocabulary that would reveal a target word is rejected.
    const bad = await w.teacher.patch(`/api/teacher/tests/${testId}`, { vocab: ['sentence'] });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'VOCAB_REVEALS_TARGET');
    assert.equal((await w.teacher.patch(`/api/teacher/tests/${testId}`, { vocab: ['a', 'b', 'c', 'd'] })).status, 400);
    // Mode cannot change once a student has started.
    assert.equal((await w.teacher.patch(`/api/teacher/tests/${testId}`, { mode: 'recovery' })).status, 409);

    const w2 = await boot();
    try {
      const rec = await publishTest(w2, { mode: 'recovery', extra: { patch: { vocab: ['timetable'] } } });
      const preRec = (await start(w2.s1, rec.testId)).state.test.prelistening;
      assert.deepEqual(preRec, { mode: 'recovery', topic: 'Fixture topic', situation: null, vocab: [] });
      const tr = await publishTest(w2, { testNumber: 2, mode: 'transfer' });
      w2.clock.advance(DAY);
      const preTr = (await start(w2.s1, tr.testId)).state.test.prelistening;
      assert.deepEqual(preTr, { mode: 'transfer', topic: null, situation: 'Fixture situation', vocab: [] });
    } finally { await w2.close(); }
  } finally { await w.close(); }
});

test('audio validation: unplayable files, out-of-range segments and unverified content are rejected', async () => {
  const w = await boot();
  try {
    const junk = await w.teacher.req('POST', '/api/teacher/audio?title=Junk&permission=1', Buffer.from('not audio at all'), { 'Content-Type': 'audio/mpeg' });
    assert.equal(junk.status, 422);
    assert.equal(junk.data.error.code, 'AUDIO_NOT_PLAYABLE');
    const noPermission = await w.teacher.req('POST', '/api/teacher/audio?title=x', Buffer.from('x'), { 'Content-Type': 'audio/mpeg' });
    assert.equal(noPermission.data.error.code, 'PERMISSION_REQUIRED');
    const audio = await uploadTone(w);
    assert.equal(audio.duration_ms, 60000);
    const beyond = await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, { start_ms: 58000, end_ms: 61000, main_skill_tag: 'word_recognition' });
    assert.equal(beyond.status, 400);
    const backwards = await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, { start_ms: 5000, end_ms: 4000, main_skill_tag: 'word_recognition' });
    assert.equal(backwards.status, 400);
    const seg = (await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, { start_ms: 1000, end_ms: 3000, main_skill_tag: 'connected_speech' })).data;
    assert.equal(seg.verification_status, 'draft');
    assert.equal(seg.duration_ms, 2000);
    const noTranscript = await w.teacher.post(`/api/teacher/segments/${seg.segment_id}/verify`, {});
    assert.equal(noTranscript.status, 422);
    await w.teacher.patch(`/api/teacher/segments/${seg.segment_id}`, { transcript: 'fixture words' });
    const short = await w.teacher.post(`/api/teacher/segments/${seg.segment_id}/verify`, {});
    assert.equal(short.data.error.code, 'DURATION_OUTSIDE_RECOMMENDED');
    const ok = await w.teacher.post(`/api/teacher/segments/${seg.segment_id}/verify`, { overrideDuration: true });
    assert.equal(ok.data.verification_status, 'verified');
    const clip = await w.teacher.get(`/api/teacher/segments/${seg.segment_id}/clip`);
    assert.equal(clip.status, 200);
    assert.ok(clip.data.length > 1000);
    // A test with an unverified sentence cannot be published.
    const draft = (await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, { start_ms: 10000, end_ms: 15000, transcript: 'x y', main_skill_tag: 'word_recognition' })).data;
    const testId = w.db.prepare('SELECT id FROM tests WHERE number = 3').pluck().get();
    await w.teacher.put(`/api/teacher/tests/${testId}/items`, { segmentIds: [draft.segment_id] });
    const pub = await w.teacher.post(`/api/teacher/tests/${testId}/status`, { status: 'published' });
    assert.equal(pub.status, 422);
    assert.ok(pub.data.error.problems.some((p) => /not verified/.test(p)));
    assert.ok(fs.existsSync(w.dataDir));
  } finally { await w.close(); }
});

test('per-student familiarity: practised for one learner can be unseen for another', async () => {
  const w = await boot();
  try {
    const { testId, segmentIds } = await publishTest(w);
    await w.teacher.post(`/api/teacher/segments/${segmentIds[0]}/exposure`, { studentId: w.users.s1, practised: true });
    const a1 = await start(w.s1, testId);
    const a2 = await start(w.s2, testId);
    const fam = (attemptId) => w.db.prepare('SELECT familiarity_at_start FROM item_attempts WHERE attempt_id = ? AND segment_id = ?').pluck().get(attemptId, segmentIds[0]);
    assert.equal(fam(a1.attemptId), 'previously_practised');
    assert.equal(fam(a2.attemptId), 'unseen');
    // Real exposure (seen transcript) cannot be undone by the teacher.
    w.db.prepare('UPDATE student_segment_exposure SET transcript_seen_at = 1 WHERE student_id = ?').run(w.users.s1);
    const undo = await w.teacher.post(`/api/teacher/segments/${segmentIds[0]}/exposure`, { studentId: w.users.s1, practised: false });
    assert.equal(undo.status, 409);
  } finally { await w.close(); }
});

test('teacher dashboard answers the daily questions', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w);
    await start(w.s1, testId);
    const d = (await w.teacher.get('/api/teacher/dashboard')).data;
    assert.equal(d.todaysTests.length, 1);
    const s1 = d.students.find((s) => s.studentId === w.users.s1);
    const s2 = d.students.find((s) => s.studentId === w.users.s2);
    assert.equal(s1.today[0].status, 'in_progress');
    assert.equal(s2.today[0].status, 'available');
    assert.deepEqual(d.completionSummary[0], { testId, title: 'Daily Test 01', submitted: 0, inProgress: 1, notStarted: 2, assigned: 3 });
    assert.equal(d.settings.items_per_test, 10);
    assert.equal(s1.pendingRemediation, 0);
  } finally { await w.close(); }
});

test('items per test: default ten, configurable, enforced at publish; source diversity is advised', async () => {
  const w = await boot();
  try {
    assert.equal((await w.teacher.get('/api/teacher/settings')).data.items_per_test, 10);
    const audio = await uploadTone(w);
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const seg = (await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, { start_ms: i * 6000, end_ms: i * 6000 + 5000, transcript: `fixture ${i}`, main_skill_tag: 'word_recognition' })).data;
      await w.teacher.post(`/api/teacher/segments/${seg.segment_id}/verify`, {});
      ids.push(seg.segment_id);
    }
    const testId = w.db.prepare('SELECT id FROM tests WHERE number = 1').pluck().get();
    await w.teacher.put(`/api/teacher/tests/${testId}/items`, { segmentIds: ids });
    await w.teacher.post('/api/teacher/schedule', { startDate: START_DATE });
    await w.teacher.patch(`/api/teacher/tests/${testId}`, { situation: 'Fixture situation' });
    let detail = (await w.teacher.get(`/api/teacher/tests/${testId}`)).data;
    assert.ok(detail.problems.some((p) => /exactly 10 sentences/.test(p)));
    assert.ok(detail.warnings.some((p) => /1 recording/.test(p)));
    assert.equal((await w.teacher.post(`/api/teacher/tests/${testId}/status`, { status: 'published' })).status, 422);
    await w.teacher.patch('/api/teacher/settings', { items_per_test: 4 });
    detail = (await w.teacher.get(`/api/teacher/tests/${testId}`)).data;
    assert.deepEqual(detail.problems, []);
    assert.equal((await w.teacher.post(`/api/teacher/tests/${testId}/status`, { status: 'published' })).status, 200);
    // Never more sentences than the configured length.
    assert.equal((await w.teacher.put(`/api/teacher/tests/${testId + 1}/items`, { segmentIds: [...ids, ids[0] + 100] })).status, 400);
  } finally { await w.close(); }
});

test('first teacher from environment; teacher adds students and resets passwords', async () => {
  const { openDatabase } = await import('../src/db.js');
  const { ensureBootstrapTeacher } = await import('../src/lib/auth.js');
  const fresh = openDatabase(':memory:');
  assert.equal(ensureBootstrapTeacher(fresh, {}), null, 'nothing without variables');
  assert.throws(() => ensureBootstrapTeacher(fresh, { CP_TEACHER_USERNAME: 'anne', CP_TEACHER_PASSWORD: 'short' }));
  assert.equal(ensureBootstrapTeacher(fresh, { CP_TEACHER_USERNAME: 'anne', CP_TEACHER_PASSWORD: 'long-enough-pw' }), 'anne');
  assert.equal(ensureBootstrapTeacher(fresh, { CP_TEACHER_USERNAME: 'anne', CP_TEACHER_PASSWORD: 'long-enough-pw' }), null, 'only once');

  const w = await boot();
  try {
    const add = await w.teacher.post('/api/teacher/students', { displayName: 'Bao Han', username: 'BaoHan', password: 'baohan' });
    assert.equal(add.status, 200);
    assert.equal(add.data.username, 'baohan');
    assert.equal((await w.teacher.post('/api/teacher/students', { displayName: 'X', username: 'bảo hân', password: 'abcdef' })).status, 400);
    assert.equal((await w.teacher.post('/api/teacher/students', { displayName: 'X', username: 'baohan', password: 'abcdef' })).status, 409);
    assert.equal((await w.s1.post('/api/teacher/students', { username: 'hack', password: 'abcdef' })).status, 403);
    const c = new Client(w.base);
    assert.equal((await c.post('/api/auth/login', { username: 'baohan', password: 'baohan' })).status, 200);
    assert.equal((await w.teacher.post(`/api/teacher/users/${add.data.id}/password`, { password: 'newpass1' })).status, 200);
    assert.equal((await c.get('/api/cp/today')).status, 401, 'old sessions are signed out');
    assert.equal((await new Client(w.base).post('/api/auth/login', { username: 'baohan', password: 'newpass1' })).status, 200);
  } finally { await w.close(); }
});
