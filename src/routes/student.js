import express from 'express';
import { tx } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { handle, idempotent } from '../lib/http.js';
import { CLIENT_EVENT_TYPES, logEvent } from '../services/activity.js';
import {
  assertCanPlayItem, getAttemptState, heartbeat, saveDraft, startAttempt, startPractice, submitItem,
} from '../services/assessment.js';
import { studentMetrics } from '../services/metrics.js';
import { authorizePlayback, completePlayback, consumeClip, interruptPlayback } from '../services/playback.js';
import {
  advanceStage, assertCanPlayReview, assertGuidedAudio, checkPractice, getReviewState, practiceAudioPath, practiceList,
  practiceState, reviewQueue, saveReviewDraft, startReview, submitDelayedReview, submitFinalRecall, submitSelfCorrection,
} from '../services/reviews.js';
import { listStudentTests, todayOverview } from '../services/student.js';

const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};

function sendClip(res, file) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Content-Disposition', 'inline');
  res.type('audio/mpeg');
  res.sendFile(file, { acceptRanges: false, lastModified: false, etag: false });
}

export function studentRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const me = (req) => req.user.id;

  r.get('/today', handle((req) => todayOverview(ctx, me(req))));
  r.get('/tests', handle((req) => ({ tests: listStudentTests(ctx, me(req)) })));
  r.get('/queue', handle((req) => reviewQueue(ctx, me(req))));
  r.get('/progress', handle((req) => studentMetrics(db, me(req))));

  // ---------------------------------------------------------------- independent test
  r.post('/tests/:id/start', handle((req) => startAttempt(ctx, {
    studentId: me(req), testId: id(req.params.id), resumeFrom: req.body?.resumeFrom ?? null,
  })));
  r.post('/tests/:id/practice/start', handle((req) => startPractice(ctx, {
    studentId: me(req), testId: id(req.params.id), resumeFrom: req.body?.resumeFrom ?? null,
  })));
  r.get('/attempts/:id', handle((req) => getAttemptState(ctx, { studentId: me(req), attemptId: id(req.params.id) })));
  r.post('/attempts/:id/items/:itemId/play', handle((req) => tx(db, () => {
    const args = { studentId: me(req), attemptId: id(req.params.id), itemAttemptId: id(req.params.itemId), sessionId: req.body?.sessionId };
    assertCanPlayItem(ctx, args);
    return authorizePlayback(ctx, { ownerType: 'item_attempt', ownerId: args.itemAttemptId, context: 'assessment', sessionId: args.sessionId });
  })));
  r.post('/attempts/:id/items/:itemId/draft', handle((req) => saveDraft(ctx, {
    studentId: me(req), attemptId: id(req.params.id), itemAttemptId: id(req.params.itemId),
    sessionId: req.body?.sessionId, text: req.body?.text,
  })));
  r.post('/attempts/:id/items/:itemId/submit', idempotent(db, (req) => submitItem(ctx, {
    studentId: me(req), attemptId: id(req.params.id), itemAttemptId: id(req.params.itemId),
    sessionId: req.body?.sessionId, text: req.body?.text, couldntCatch: Boolean(req.body?.couldntCatch),
  })));

  // ---------------------------------------------------------------- playback
  r.get('/clip/:token', (req, res, next) => {
    try {
      const file = tx(db, () => consumeClip(ctx, { token: req.params.token, studentId: me(req) }));
      sendClip(res, file);
    } catch (err) { next(err); }
  });
  r.post('/playback/:token/complete', handle((req) => {
    tx(db, () => completePlayback(ctx, { token: req.params.token, studentId: me(req) }));
  }));
  r.post('/playback/:token/interrupt', handle((req) => {
    tx(db, () => interruptPlayback(ctx, { token: req.params.token, studentId: me(req), reason: req.body?.reason }));
  }));

  // ---------------------------------------------------------------- session + activity
  r.post('/sessions/:sid/heartbeat', handle((req) => heartbeat(ctx, { studentId: me(req), sessionId: req.params.sid, visible: Boolean(req.body?.visible) })));
  r.post('/events', handle((req) => {
    const { sessionId, type, clientTs, metadata = {} } = req.body ?? {};
    if (!CLIENT_EVENT_TYPES.has(type)) throw badRequest('INVALID_EVENT', 'Unknown event type.');
    const session = db.prepare('SELECT * FROM cp_sessions WHERE id = ? AND student_id = ?').get(sessionId, me(req));
    if (!session) throw notFound();
    const log = {};
    if (session.scope_type === 'test') {
      const a = db.prepare('SELECT id, test_id, current_position FROM assessment_attempts WHERE id = ?').get(session.scope_id);
      const ia = db.prepare('SELECT test_item_id FROM item_attempts WHERE attempt_id = ? AND position = ?').get(a.id, a.current_position);
      Object.assign(log, { testId: a.test_id, attemptId: a.id, itemId: ia?.test_item_id ?? null });
    } else {
      const ri = db.prepare('SELECT ri.id, ri.test_id, ri.test_item_id FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id WHERE ra.id = ?').get(session.scope_id);
      Object.assign(log, { testId: ri.test_id, itemId: ri.test_item_id, reviewItemId: ri.id });
    }
    // Only a few plain fields are kept; clipboard contents are never read or sent.
    const meta = {
      hiddenMs: Number.isFinite(metadata.hiddenMs) ? Math.trunc(metadata.hiddenMs) : undefined,
      during: typeof metadata.during === 'string' ? metadata.during.slice(0, 30) : undefined,
      via: typeof metadata.via === 'string' ? metadata.via.slice(0, 30) : undefined,
      scope: session.scope_type,
      reviewAttemptId: session.scope_type === 'review' ? session.scope_id : undefined,
    };
    logEvent(db, ctx.clock.now(), { studentId: me(req), ...log, type, clientTs: Number(clientTs), metadata: meta });
  }));

  // ---------------------------------------------------------------- reviews
  r.post('/reviews/:id/start', handle((req) => startReview(ctx, {
    studentId: me(req), reviewItemId: id(req.params.id), resumeFrom: req.body?.resumeFrom ?? null,
  })));
  r.get('/review-attempts/:id', handle((req) => getReviewState(ctx, { studentId: me(req), reviewAttemptId: id(req.params.id) })));
  r.post('/review-attempts/:id/play', handle((req) => tx(db, () => {
    const args = { studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId };
    const context = assertCanPlayReview(ctx, args);
    return authorizePlayback(ctx, { ownerType: 'review_attempt', ownerId: args.reviewAttemptId, context, sessionId: args.sessionId });
  })));
  r.post('/review-attempts/:id/draft', handle((req) => saveReviewDraft(ctx, {
    studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId, text: req.body?.text,
  })));
  r.post('/review-attempts/:id/self-correction', idempotent(db, (req) => submitSelfCorrection(ctx, {
    studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId, text: req.body?.text,
  })));
  r.post('/review-attempts/:id/advance', idempotent(db, (req) => advanceStage(ctx, {
    studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId, from: req.body?.from,
  })));
  r.post('/review-attempts/:id/final-recall', idempotent(db, (req) => submitFinalRecall(ctx, {
    studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId, text: req.body?.text,
  })));
  r.post('/review-attempts/:id/delayed-submit', idempotent(db, (req) => submitDelayedReview(ctx, {
    studentId: me(req), reviewAttemptId: id(req.params.id), sessionId: req.body?.sessionId,
    text: req.body?.text, couldntCatch: Boolean(req.body?.couldntCatch),
  })));
  // Guided Listening is instructional, so this clip may be paused, sought and slowed (Range requests allowed).
  r.get('/review-attempts/:id/guided-audio', (req, res, next) => {
    try {
      const file = assertGuidedAudio(ctx, { studentId: me(req), reviewAttemptId: id(req.params.id) });
      res.set('Cache-Control', 'no-store, private');
      res.type('audio/mpeg');
      res.sendFile(file);
    } catch (err) { next(err); }
  });

  // ---------------------------------------------------------------- free practice of reviewed sentences
  r.get('/practice', handle((req) => ({ items: practiceList(ctx, me(req)) })));
  r.get('/practice/:id', handle((req) => practiceState(ctx, { studentId: me(req), reviewItemId: id(req.params.id) })));
  r.get('/practice/:id/audio', (req, res, next) => {
    try {
      const file = practiceAudioPath(ctx, { studentId: me(req), reviewItemId: id(req.params.id) });
      res.set('Cache-Control', 'no-store, private');
      res.type('audio/mpeg');
      res.sendFile(file);
    } catch (err) { next(err); }
  });
  r.post('/practice/:id/check', idempotent(db, (req) => checkPractice(ctx, {
    studentId: me(req), reviewItemId: id(req.params.id), text: req.body?.text,
  })));

  return r;
}
