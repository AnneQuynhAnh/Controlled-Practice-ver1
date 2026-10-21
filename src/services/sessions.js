import crypto from 'node:crypto';
import { conflict } from '../lib/errors.js';
import { logEvent } from './activity.js';

// A prior session seen within this window when another one opens counts as concurrent use.
const CONCURRENT_WINDOW_MS = 90_000;

/**
 * Open the single active session for (student, scope), superseding any other.
 * resumeFrom is the session id this same browser tab held before a reload; taking that one over is not "concurrent".
 */
export function openSession(ctx, { studentId, scopeType, scopeId, resumeFrom = null, log = {} }) {
  const { db, clock } = ctx;
  const now = clock.now();
  const active = db.prepare(
    'SELECT * FROM cp_sessions WHERE student_id = ? AND scope_type = ? AND scope_id = ? AND ended_at IS NULL'
  ).all(studentId, scopeType, scopeId);
  let concurrent = false;
  for (const s of active) {
    db.prepare("UPDATE cp_sessions SET ended_at = ?, ended_reason = 'superseded' WHERE id = ?").run(now, s.id);
    if (s.id !== resumeFrom && now - s.last_seen_at < CONCURRENT_WINDOW_MS) concurrent = true;
  }
  if (concurrent) {
    logEvent(db, now, { studentId, ...log, type: 'concurrent_session_detected', metadata: { scopeType, scopeId } });
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO cp_sessions (id, student_id, scope_type, scope_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, studentId, scopeType, scopeId, now, now);
  return { id, resumedPrevious: active.length > 0, concurrent };
}

export function assertSession(ctx, { sessionId, studentId, scopeType, scopeId }) {
  const row = sessionId && ctx.db.prepare('SELECT * FROM cp_sessions WHERE id = ?').get(sessionId);
  if (!row || row.student_id !== studentId || row.scope_type !== scopeType || row.scope_id !== scopeId) {
    throw conflict('SESSION_INVALID', 'This session is no longer valid. Reload the page to continue.');
  }
  if (row.ended_at) {
    throw conflict('SESSION_SUPERSEDED', 'This activity was opened in another tab or device. Continue there, or reload here to take over.');
  }
  ctx.db.prepare('UPDATE cp_sessions SET last_seen_at = ? WHERE id = ?').run(ctx.clock.now(), row.id);
  return row;
}
