import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  boot, FIXTURE_SENTENCES, itemPlayUrl, playFull, publishTest, start, transcriptFor,
} from './helpers.js';

describe('strict independent assessment', () => {
  let w;
  let testId;
  before(async () => {
    w = await boot();
    ({ testId } = await publishTest(w));
  });
  after(() => w.close());

  test('req 1: a student cannot exceed two authorized playback starts', async () => {
    const { attemptId, sessionId, state } = await start(w.s1, testId);
    const url = itemPlayUrl(attemptId, state.item.id);
    assert.equal(state.item.plays.used, 0);
    assert.equal(state.attempt.itemCount, 10);
    assert.equal(state.item.plays.allowed, 2);
    await playFull(w, w.s1, url, sessionId);
    await playFull(w, w.s1, url, sessionId);
    const third = await w.s1.post(url, { sessionId });
    assert.equal(third.status, 403);
    assert.equal(third.data.error.code, 'PLAY_LIMIT');
    const row = w.db.prepare('SELECT * FROM item_attempts WHERE id = ?').get(state.item.id);
    assert.equal(row.playback_start_count, 2);
    assert.equal(row.playback_completed_count, 2);
    assert.equal(row.playback_interruption_count, 0);
  });

  test('req 2 / 18: play count, draft, order and locks survive a reload; no extra starts are granted', async () => {
    const { attemptId, sessionId, state } = await start(w.s2, testId);
    const url = itemPlayUrl(attemptId, state.item.id);
    const auth = await w.s2.post(url, { sessionId });
    await w.s2.get(auth.data.clipUrl); // audio is playing when the student reloads
    const order = w.db.prepare('SELECT test_item_id FROM item_attempts WHERE attempt_id = ? ORDER BY position').pluck().all(attemptId);

    const re = await start(w.s2, testId, sessionId);
    assert.equal(re.attemptId, attemptId);
    assert.equal(re.state.item.id, state.item.id);
    assert.equal(re.state.item.plays.used, 1, 'the interrupted start stays counted');
    assert.equal(re.state.item.plays.interrupted, 1);
    assert.equal(re.state.item.plays.inFlight, false);
    // Finish the item using the second (last) listen, save a draft, then reload again.
    await playFull(w, w.s2, url, re.sessionId);
    const d = await w.s2.post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/draft`, { sessionId: re.sessionId, text: 'draft words' });
    assert.equal(d.status, 200);
    const re2 = await start(w.s2, testId, re.sessionId);
    assert.equal(re2.state.item.draft, 'draft words');
    assert.equal(re2.state.item.plays.used, 2);
    assert.equal((await w.s2.post(url, { sessionId: re2.sessionId })).status, 403, 'refresh grants no extra plays');
    const order2 = w.db.prepare('SELECT test_item_id FROM item_attempts WHERE attempt_id = ? ORDER BY position').pluck().all(attemptId);
    assert.deepEqual(order2, order, 'req 8: item order is frozen');
    // Submit item 1, reload: item 1 is locked and item 2 is current.
    await w.s2.post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/submit`, { sessionId: re2.sessionId, text: 'draft words' });
    const re3 = await start(w.s2, testId, re2.sessionId);
    assert.equal(re3.state.item.position, 2);
    assert.equal(w.db.prepare('SELECT status FROM item_attempts WHERE id = ?').pluck().get(state.item.id), 'submitted');
  });

  test('req 4: the clip is single-use, served whole (no ranges) and not cacheable', async () => {
    const { attemptId, sessionId } = await start(w.s3, testId);
    const st = await w.s3.get(`/api/cp/attempts/${attemptId}`);
    const auth = await w.s3.post(itemPlayUrl(attemptId, st.data.item.id), { sessionId });
    const clip = await w.s3.get(auth.data.clipUrl, { Range: 'bytes=1000-2000' });
    assert.equal(clip.status, 200, 'no partial content');
    assert.match(clip.headers.get('content-type'), /audio\/mpeg/);
    assert.match(clip.headers.get('cache-control'), /no-store/);
    assert.equal(clip.headers.get('accept-ranges'), null);
    const again = await w.s3.get(auth.data.clipUrl);
    assert.equal(again.status, 410);
    // Completion before the sentence could have finished is refused.
    const early = await w.s3.post(`/api/cp/playback/${auth.data.token}/complete`);
    assert.equal(early.status, 409);
    assert.equal(early.data.error.code, 'PLAY_TOO_EARLY');
    // Another student cannot use this token.
    assert.equal((await w.s1.get(auth.data.clipUrl)).status, 404);
    w.clock.advance(6000);
    assert.equal((await w.s3.post(`/api/cp/playback/${auth.data.token}/complete`)).status, 200);
  });

  test('req 5 (server): writing is refused before the first full play and while audio plays', async () => {
    const w2 = await boot();
    try {
      const { testId: t2 } = await publishTest(w2);
      const { attemptId, sessionId, state } = await start(w2.s1, t2);
      const draftUrl = `/api/cp/attempts/${attemptId}/items/${state.item.id}/draft`;
      const submitUrl = `/api/cp/attempts/${attemptId}/items/${state.item.id}/submit`;
      assert.equal((await w2.s1.post(draftUrl, { sessionId, text: 'a' })).data.error.code, 'WRITING_LOCKED');
      assert.equal((await w2.s1.post(submitUrl, { sessionId, text: 'a' })).data.error.code, 'WRITING_LOCKED');
      const auth = await w2.s1.post(itemPlayUrl(attemptId, state.item.id), { sessionId });
      await w2.s1.get(auth.data.clipUrl);
      assert.equal((await w2.s1.post(draftUrl, { sessionId, text: 'a' })).data.error.code, 'PLAYBACK_ACTIVE');
      assert.equal((await w2.s1.post(itemPlayUrl(attemptId, state.item.id), { sessionId })).data.error.code, 'PLAY_IN_PROGRESS');
    } finally { await w2.close(); }
  });

  test('req 6 / 7 / 24: blank and incomplete answers submit; submitted answers are locked and immutable', async () => {
    const w2 = await boot();
    try {
      const { testId: t2 } = await publishTest(w2);
      const { attemptId, sessionId, state } = await start(w2.s1, t2);
      // "I couldn't catch it" after the first listen
      await playFull(w2, w2.s1, itemPlayUrl(attemptId, state.item.id), sessionId);
      const blank = await w2.s1.post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/submit`, { sessionId, couldntCatch: true });
      assert.equal(blank.status, 200);
      const again = await w2.s1.post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/submit`, { sessionId, text: 'changed' });
      assert.equal(again.status, 409);
      assert.equal(again.data.error.code, 'ALREADY_SUBMITTED');
      const st = await w2.s1.get(`/api/cp/attempts/${attemptId}`);
      await playFull(w2, w2.s1, itemPlayUrl(attemptId, st.data.item.id), sessionId);
      const partial = await w2.s1.post(`/api/cp/attempts/${attemptId}/items/${st.data.item.id}/submit`, { sessionId, text: 'fixture' });
      assert.equal(partial.status, 200);
      // No backward navigation: playing the previous item is refused.
      assert.equal((await w2.s1.post(itemPlayUrl(attemptId, state.item.id), { sessionId })).status, 409);
      // The database itself refuses to change an original answer.
      assert.throws(() => w2.db.prepare('UPDATE submitted_answers SET answer_text = ? WHERE attempt_id = ?').run('x', attemptId), /immutable/);
      assert.throws(() => w2.db.prepare('DELETE FROM submitted_answers WHERE attempt_id = ?').run(attemptId), /immutable/);
      // Feedback is not revealed per question.
      assert.equal(partial.data.finished, false);
      assert.equal(JSON.stringify(partial.data).includes('wordAccuracy'), false);
    } finally { await w2.close(); }
  });

  test('req 9: hidden transcripts never appear in assessment responses', async () => {
    const w2 = await boot();
    try {
      const { testId: t2 } = await publishTest(w2);
      const { attemptId, sessionId, state } = await start(w2.s1, t2);
      const bodies = [];
      const st = await w2.s1.get(`/api/cp/attempts/${attemptId}`);
      bodies.push(st.data, state);
      const auth = await playFull(w2, w2.s1, itemPlayUrl(attemptId, state.item.id), sessionId);
      bodies.push(auth.data);
      bodies.push((await w2.s1.get('/api/cp/tests')).data, (await w2.s1.get('/api/cp/today')).data);
      const json = JSON.stringify(bodies);
      for (const sentence of FIXTURE_SENTENCES) assert.equal(json.includes(sentence), false);
      assert.equal(json.includes('Fixture tone'), false, 'source names stay hidden');
      assert.equal(json.includes('source'), false);
      assert.equal(json.includes('transcript'), false);
      assert.equal(/wordCount|word_count|refWordCount/.test(json), false, 'no word count hint');
      // Students cannot reach teacher endpoints that hold transcripts.
      assert.equal((await w2.s1.get(`/api/teacher/tests/${t2}`)).status, 403);
      assert.equal((await w2.s1.get('/api/teacher/segments')).status, 403);
      assert.ok(transcriptFor(w2, state.item.id));
    } finally { await w2.close(); }
  });

  test('req 19: a superseded session cannot submit, and parallel submits do not duplicate', async () => {
    const w2 = await boot();
    try {
      const { testId: t2 } = await publishTest(w2);
      const a = await start(w2.s1, t2);
      await playFull(w2, w2.s1, itemPlayUrl(a.attemptId, a.state.item.id), a.sessionId);
      const b = await start(w2.s1, t2); // second tab / device
      const stale = await w2.s1.post(`/api/cp/attempts/${a.attemptId}/items/${a.state.item.id}/submit`, { sessionId: a.sessionId, text: 'one' });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error.code, 'SESSION_SUPERSEDED');
      const url = `/api/cp/attempts/${a.attemptId}/items/${a.state.item.id}/submit`;
      const results = await Promise.all([
        w2.s1.post(url, { sessionId: b.sessionId, text: 'one' }, { 'Idempotency-Key': 'key-aaaaaaaa' }),
        w2.s1.post(url, { sessionId: b.sessionId, text: 'two' }, { 'Idempotency-Key': 'key-bbbbbbbb' }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      // A network retry with the same key replays the original success instead of failing or duplicating.
      const winner = results.find((r) => r.status === 200);
      const key = winner === results[0] ? 'key-aaaaaaaa' : 'key-bbbbbbbb';
      const retry = await w2.s1.post(url, { sessionId: b.sessionId, text: 'one' }, { 'Idempotency-Key': key });
      assert.equal(retry.status, 200);
      assert.equal(w2.db.prepare('SELECT COUNT(*) FROM submitted_answers WHERE attempt_id = ?').pluck().get(a.attemptId), 1);
      const events = w2.db.prepare("SELECT COUNT(*) FROM activity_events WHERE event_type = 'concurrent_session_detected'").pluck().get();
      assert.equal(events, 1);
    } finally { await w2.close(); }
  });

  test('whole-test submission locks the attempt, scores it and reveals a summary only at the end', async () => {
    const w2 = await boot();
    try {
      const { testId: t2 } = await publishTest(w2);
      const { attemptId, sessionId } = await start(w2.s1, t2);
      // Answer the first two sentences correctly (transcript read from the DB as the oracle).
      const out = await (async () => {
        let last;
        for (let i = 0; i < 10; i++) {
          const st = await w2.s1.get(`/api/cp/attempts/${attemptId}`);
          await playFull(w2, w2.s1, itemPlayUrl(attemptId, st.data.item.id), sessionId);
          const text = i < 2 ? transcriptFor(w2, st.data.item.id).toUpperCase() + '.' : 'something else';
          last = await w2.s1.post(`/api/cp/attempts/${attemptId}/items/${st.data.item.id}/submit`, { sessionId, text });
        }
        return last.data;
      })();
      assert.equal(out.finished, true);
      assert.equal(out.summary.exactCount, 2);
      assert.equal(out.summary.items.length, 10);
      assert.equal(out.summary.itemCount, 10);
      assert.equal(w2.db.prepare('SELECT status FROM assessment_attempts WHERE id = ?').pluck().get(attemptId), 'submitted');
      const restart = await w2.s1.post(`/api/cp/tests/${t2}/start`, {});
      assert.equal(restart.data.submitted, true);
    } finally { await w2.close(); }
  });
});
