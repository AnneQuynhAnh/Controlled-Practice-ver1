import crypto from 'node:crypto';

/** Events a client may report. Everything else is written by the server at the moment it happens. */
export const CLIENT_EVENT_TYPES = new Set(['tab_hidden', 'tab_visible', 'paste_attempt', 'copy_attempt']);

export function logEvent(db, now, {
  studentId, testId = null, itemId = null, attemptId = null, reviewItemId = null,
  type, clientTs = null, metadata = {}, eventId = crypto.randomUUID(),
}) {
  const clientTime = Number.isFinite(clientTs) ? Math.trunc(clientTs) : null;
  db.prepare(
    `INSERT OR IGNORE INTO activity_events
       (event_id, student_id, test_id, item_id, attempt_id, review_item_id, event_type, server_ts, client_ts, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, studentId, testId, itemId, attemptId, reviewItemId, type, now, clientTime, JSON.stringify(metadata));
}

export function logTeacherAction(db, now, { teacherId, action, targetType, targetId = null, studentId = null, reason = '', metadata = {} }) {
  db.prepare(
    `INSERT INTO teacher_actions (teacher_id, action, target_type, target_id, student_id, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(teacherId, action, targetType, targetId, studentId, reason, JSON.stringify(metadata), now);
}
