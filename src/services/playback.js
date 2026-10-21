import crypto from 'node:crypto';
import { conflict, forbidden, notFound, HttpError } from '../lib/errors.js';
import { logEvent } from './activity.js';

export const PLAY_LIMITS = {
  assessment: 2,
  delayed_review: 2,
  self_correction: 3,
  guided_full: 2,
  final_recall: 1,
};
const FETCH_WINDOW_MS = 60_000;     // an authorization must be fetched within this time
const STALE_GRACE_MS = 20_000;      // beyond clip length, an unfinished play is considered interrupted
const COMPLETE_TOLERANCE_MS = 1_500;

/** Resolve logging and ownership context for a playback owner. */
export function ownerContext(db, ownerType, ownerId) {
  if (ownerType === 'item_attempt') {
    const row = db.prepare(
      `SELECT ia.id, ia.segment_id, ia.test_item_id, ia.credits_restored, a.id AS attempt_id, a.test_id, a.student_id
         FROM item_attempts ia JOIN assessment_attempts a ON a.id = ia.attempt_id WHERE ia.id = ?`
    ).get(ownerId);
    if (!row) throw notFound();
    return {
      studentId: row.student_id, segmentId: row.segment_id, credits: row.credits_restored,
      log: { testId: row.test_id, attemptId: row.attempt_id, itemId: row.test_item_id },
      scope: { scopeType: 'test', scopeId: row.attempt_id },
    };
  }
  const row = db.prepare(
    `SELECT ra.id, ra.credits_restored, ri.id AS review_item_id, ri.student_id, ri.segment_id, ri.test_id, ri.test_item_id
       FROM review_attempts ra JOIN review_items ri ON ri.id = ra.review_item_id WHERE ra.id = ?`
  ).get(ownerId);
  if (!row) throw notFound();
  return {
    studentId: row.student_id, segmentId: row.segment_id, credits: row.credits_restored,
    log: { testId: row.test_id, itemId: row.test_item_id, reviewItemId: row.review_item_id },
    scope: { scopeType: 'review', scopeId: row.id },
  };
}

function endPlayback(ctx, ev, status, reason) {
  const now = ctx.clock.now();
  ctx.db.prepare('UPDATE playback_events SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?').run(status, now, reason, ev.id);
  const owner = ownerContext(ctx.db, ev.owner_type, ev.owner_id);
  logEvent(ctx.db, now, {
    studentId: ev.student_id, ...owner.log,
    type: status === 'completed' ? 'audio_play_completed' : 'audio_play_interrupted',
    metadata: { context: ev.context, reason, playbackId: ev.id, reviewAttemptId: ev.owner_type === 'review_attempt' ? ev.owner_id : undefined },
  });
  if (ev.owner_type === 'item_attempt') syncItemCounts(ctx.db, ev.owner_id, status === 'completed' ? now : null);
  if (status === 'completed') recordHeard(ctx.db, ev.student_id, ev.segment_id, now);
}

/** Mark plays that can no longer be running as interrupted. Starts stay counted. */
export function sweepStale(ctx, ownerType, ownerId) {
  const now = ctx.clock.now();
  const open = ctx.db.prepare(
    "SELECT * FROM playback_events WHERE owner_type = ? AND owner_id = ? AND status IN ('authorized', 'fetched')"
  ).all(ownerType, ownerId);
  for (const ev of open) {
    if (ev.status === 'authorized' && now - ev.authorized_at > FETCH_WINDOW_MS) endPlayback(ctx, ev, 'interrupted', 'not_loaded');
    else if (ev.status === 'fetched' && now - ev.fetched_at > ev.duration_ms + STALE_GRACE_MS) endPlayback(ctx, ev, 'interrupted', 'stale');
  }
}

/** Interrupt every running play for an owner (used on reload / session takeover). */
export function interruptAll(ctx, ownerType, ownerId, reason) {
  const open = ctx.db.prepare(
    "SELECT * FROM playback_events WHERE owner_type = ? AND owner_id = ? AND status IN ('authorized', 'fetched')"
  ).all(ownerType, ownerId);
  for (const ev of open) endPlayback(ctx, ev, 'interrupted', reason);
}

export function playbackState(ctx, ownerType, ownerId, context, credits = 0) {
  sweepStale(ctx, ownerType, ownerId);
  const rows = ctx.db.prepare(
    'SELECT status FROM playback_events WHERE owner_type = ? AND owner_id = ? AND context = ?'
  ).all(ownerType, ownerId, context);
  const inFlight = ctx.db.prepare(
    "SELECT id FROM playback_events WHERE owner_type = ? AND owner_id = ? AND status IN ('authorized', 'fetched')"
  ).get(ownerType, ownerId);
  const allowed = PLAY_LIMITS[context] + (context === 'assessment' || context === 'delayed_review' ? credits : 0);
  return {
    used: rows.length,
    allowed,
    completed: rows.filter((r) => r.status === 'completed').length,
    interrupted: rows.filter((r) => r.status === 'interrupted').length,
    inFlight: Boolean(inFlight),
  };
}

function syncItemCounts(db, itemAttemptId, completedAt) {
  const c = db.prepare(
    `SELECT COUNT(*) AS starts,
            SUM(status = 'completed') AS completed,
            SUM(status = 'interrupted') AS interrupted
       FROM playback_events WHERE owner_type = 'item_attempt' AND owner_id = ?`
  ).get(itemAttemptId);
  db.prepare(
    `UPDATE item_attempts SET playback_start_count = ?, playback_completed_count = ?, playback_interruption_count = ?,
            last_play_completed_at = COALESCE(?, last_play_completed_at) WHERE id = ?`
  ).run(c.starts, c.completed ?? 0, c.interrupted ?? 0, completedAt, itemAttemptId);
}

export function recordHeard(db, studentId, segmentId, now) {
  db.prepare(
    `INSERT INTO student_segment_exposure (student_id, segment_id, first_heard_at) VALUES (?, ?, ?)
     ON CONFLICT (student_id, segment_id) DO UPDATE SET first_heard_at = COALESCE(first_heard_at, excluded.first_heard_at)`
  ).run(studentId, segmentId, now);
}

export function recordTranscriptSeen(db, studentId, segmentId, now) {
  db.prepare(
    `INSERT INTO student_segment_exposure (student_id, segment_id, transcript_seen_at) VALUES (?, ?, ?)
     ON CONFLICT (student_id, segment_id) DO UPDATE SET transcript_seen_at = COALESCE(transcript_seen_at, excluded.transcript_seen_at)`
  ).run(studentId, segmentId, now);
}

/**
 * Authorize one full-segment playback start. Must run inside an IMMEDIATE transaction so two tabs
 * cannot both pass the limit check.
 */
export function authorizePlayback(ctx, { ownerType, ownerId, context, sessionId }) {
  const { db, clock } = ctx;
  const owner = ownerContext(db, ownerType, ownerId);
  const state = playbackState(ctx, ownerType, ownerId, context, owner.credits);
  if (state.inFlight) throw conflict('PLAY_IN_PROGRESS', 'The audio is already playing.');
  if (state.used >= state.allowed) {
    throw forbidden('PLAY_LIMIT', `You have used all ${state.allowed} listens for this sentence.`, { plays: state });
  }
  const segment = db.prepare('SELECT id, duration_ms, clip_path FROM audio_segments WHERE id = ?').get(owner.segmentId);
  if (!segment?.clip_path) throw new HttpError(503, 'AUDIO_UNAVAILABLE', 'The audio for this sentence is unavailable. Your teacher has been notified.');
  const now = clock.now();
  const token = crypto.randomBytes(24).toString('base64url');
  const info = db.prepare(
    `INSERT INTO playback_events (token, student_id, owner_type, owner_id, context, segment_id, session_id, status, duration_ms, authorized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?)`
  ).run(token, owner.studentId, ownerType, ownerId, context, segment.id, sessionId ?? null, segment.duration_ms, now);
  if (ownerType === 'item_attempt') syncItemCounts(db, ownerId, null);
  logEvent(db, now, {
    studentId: owner.studentId, ...owner.log, type: 'audio_play_started',
    metadata: { context, playbackId: Number(info.lastInsertRowid), playNumber: state.used + 1, reviewAttemptId: ownerType === 'review_attempt' ? ownerId : undefined },
  });
  return { token, clipUrl: `/api/cp/clip/${token}`, durationMs: segment.duration_ms, plays: { ...state, used: state.used + 1, inFlight: true } };
}

/** Single-use: the clip for a token can be downloaded exactly once, shortly after authorization. */
export function consumeClip(ctx, { token, studentId }) {
  const ev = ctx.db.prepare('SELECT * FROM playback_events WHERE token = ?').get(token);
  if (!ev || ev.student_id !== studentId) throw notFound();
  if (ev.status !== 'authorized') throw new HttpError(410, 'CLIP_USED', 'This listen has already been used.');
  const now = ctx.clock.now();
  if (now - ev.authorized_at > FETCH_WINDOW_MS) throw new HttpError(410, 'AUTH_EXPIRED', 'This listen authorization expired.');
  ctx.db.prepare("UPDATE playback_events SET status = 'fetched', fetched_at = ? WHERE id = ?").run(now, ev.id);
  return ctx.db.prepare('SELECT clip_path FROM audio_segments WHERE id = ?').get(ev.segment_id).clip_path;
}

function eventForStudent(ctx, token, studentId) {
  const ev = ctx.db.prepare('SELECT * FROM playback_events WHERE token = ?').get(token);
  if (!ev || ev.student_id !== studentId) throw notFound();
  return ev;
}

export function completePlayback(ctx, { token, studentId }) {
  const ev = eventForStudent(ctx, token, studentId);
  if (ev.status === 'completed') return ev;
  if (ev.status !== 'fetched') throw conflict('PLAY_NOT_ACTIVE', 'This listen is not active.');
  const elapsed = ctx.clock.now() - ev.fetched_at;
  if (elapsed + COMPLETE_TOLERANCE_MS < ev.duration_ms) {
    throw conflict('PLAY_TOO_EARLY', 'The sentence has not finished playing yet.');
  }
  endPlayback(ctx, ev, 'completed', null);
  return ev;
}

export function interruptPlayback(ctx, { token, studentId, reason }) {
  const ev = eventForStudent(ctx, token, studentId);
  if (ev.status === 'authorized' || ev.status === 'fetched') {
    endPlayback(ctx, ev, 'interrupted', String(reason || 'unknown').slice(0, 40));
  }
  return ev;
}
