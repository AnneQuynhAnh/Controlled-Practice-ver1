import { badRequest } from '../lib/errors.js';
import { logTeacherAction } from './activity.js';

const LIMITS = {
  items_per_test: [1, 30],
  daily_guided_review_limit: [1, 20],
  daily_delayed_review_cap: [1, 20],
  min_sources_per_test: [1, 30],
};

export function getSettings(db) {
  const { id: _id, updated_at: _u, ...s } = db.prepare('SELECT * FROM cp_settings WHERE id = 1').get();
  return s;
}

export function updateSettings(ctx, { teacherId, patch }) {
  const { db, clock } = ctx;
  const next = getSettings(db);
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest('INVALID_SETTING', `${key} must be a whole number from ${min} to ${max}.`);
    next[key] = n;
  }
  const now = clock.now();
  db.prepare(
    `UPDATE cp_settings SET items_per_test = ?, daily_guided_review_limit = ?, daily_delayed_review_cap = ?, min_sources_per_test = ?, updated_at = ? WHERE id = 1`
  ).run(next.items_per_test, next.daily_guided_review_limit, next.daily_delayed_review_cap, next.min_sources_per_test, now);
  logTeacherAction(db, now, { teacherId, action: 'update_settings', targetType: 'cp_settings', targetId: 1, metadata: next });
  return next;
}
