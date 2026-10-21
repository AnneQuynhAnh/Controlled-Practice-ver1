import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, itemPlayUrl, playFull, publishTest, start } from './helpers.js';

test('req 20: tab switching is logged, interrupts playback, and does not reset listens', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w);
    const { attemptId, sessionId, state } = await start(w.s1, testId);
    const auth = await w.s1.post(itemPlayUrl(attemptId, state.item.id), { sessionId });
    await w.s1.get(auth.data.clipUrl);
    // Client reports the tab became hidden: stop the audio and log it.
    await w.s1.post(`/api/cp/playback/${auth.data.token}/interrupt`, { reason: 'tab_hidden' });
    assert.equal((await w.s1.post('/api/cp/events', { sessionId, type: 'tab_hidden', clientTs: Date.now(), metadata: { during: 'playback' } })).status, 200);
    assert.equal((await w.s1.post('/api/cp/events', { sessionId, type: 'tab_visible', clientTs: Date.now(), metadata: { hiddenMs: 4200 } })).status, 200);
    const types = w.db.prepare('SELECT event_type FROM activity_events WHERE attempt_id = ? ORDER BY id').pluck().all(attemptId);
    for (const t of ['test_started', 'item_opened', 'audio_play_started', 'audio_play_interrupted', 'tab_hidden', 'tab_visible']) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
    const st = (await w.s1.get(`/api/cp/attempts/${attemptId}`)).data;
    assert.equal(st.item.plays.used, 1);
    assert.equal(st.item.plays.interrupted, 1);
    const ia = w.db.prepare('SELECT * FROM item_attempts WHERE id = ?').get(state.item.id);
    assert.equal(ia.playback_interruption_count, 1);
    // Unknown or server-only event types cannot be injected by the client.
    assert.equal((await w.s1.post('/api/cp/events', { sessionId, type: 'test_submitted' })).status, 400);
  } finally { await w.close(); }
});

test('req 21: paste attempts are recorded without clipboard contents; teacher sees flags', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w);
    const { attemptId, sessionId } = await start(w.s1, testId);
    await w.s1.post('/api/cp/events', { sessionId, type: 'paste_attempt', metadata: { via: 'keyboard', clipboard: 'SECRET' } });
    const row = w.db.prepare("SELECT * FROM activity_events WHERE event_type = 'paste_attempt'").get();
    assert.equal(row.attempt_id, attemptId);
    assert.equal(row.metadata.includes('SECRET'), false);
    assert.equal((await w.s1.post('/api/cp/events', { sessionId, type: 'copy_attempt', metadata: { via: 'copy' } })).status, 200);
    for (let i = 0; i < 3; i++) await w.s1.post('/api/cp/events', { sessionId, type: 'tab_hidden' });
    const detail = (await w.teacher.get(`/api/teacher/attempts/${attemptId}`)).data;
    const codes = detail.flags.map((f) => f.code);
    assert.ok(codes.includes('paste_attempts'));
    assert.ok(codes.includes('tab_exits'));
    assert.ok(codes.includes('copy_attempts'));
    assert.ok(detail.timeline.length > 0);
  } finally { await w.close(); }
});

test('technical recovery: interrupted listens are preserved and a teacher can restore one with a reason', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w);
    const { attemptId, sessionId, state } = await start(w.s1, testId);
    const url = itemPlayUrl(attemptId, state.item.id);
    for (let i = 0; i < 2; i++) {
      const a = await w.s1.post(url, { sessionId });
      await w.s1.post(`/api/cp/playback/${a.data.token}/interrupt`, { reason: 'load_error' });
    }
    let st = (await w.s1.get(`/api/cp/attempts/${attemptId}`)).data;
    assert.equal(st.item.recovery, true);
    assert.equal(st.item.canWrite, false);
    assert.equal(st.item.canCouldntCatch, true);
    const queue = (await w.teacher.get('/api/teacher/recovery')).data;
    assert.ok(queue.items.some((i) => i.id === state.item.id));
    const noReason = await w.teacher.post('/api/teacher/restore-credit', { ownerType: 'item_attempt', ownerId: state.item.id, reason: '' });
    assert.equal(noReason.status, 400);
    await w.teacher.post('/api/teacher/restore-credit', { ownerType: 'item_attempt', ownerId: state.item.id, reason: 'Audio failed to load on school wifi' });
    st = (await w.s1.get(`/api/cp/attempts/${attemptId}`)).data;
    assert.equal(st.item.plays.allowed, 3);
    assert.equal(st.item.recovery, false);
    await playFull(w, w.s1, url, sessionId);
    assert.equal((await w.s1.get(`/api/cp/attempts/${attemptId}`)).data.item.canWrite, true);
    const action = w.db.prepare("SELECT * FROM teacher_actions WHERE action = 'restore_play_credit'").get();
    assert.equal(action.reason, 'Audio failed to load on school wifi');
  } finally { await w.close(); }
});

test('an abandoned play becomes an interruption instead of blocking or refunding', async () => {
  const w = await boot();
  try {
    const { testId } = await publishTest(w);
    const { attemptId, sessionId, state } = await start(w.s1, testId);
    const url = itemPlayUrl(attemptId, state.item.id);
    const a = await w.s1.post(url, { sessionId });
    await w.s1.get(a.data.clipUrl);
    w.clock.advance(60_000);
    const b = await w.s1.post(url, { sessionId });
    assert.equal(b.status, 200);
    assert.equal(b.data.plays.used, 2);
    assert.equal(b.data.plays.interrupted, 1);
  } finally { await w.close(); }
});
