import { HttpError } from './errors.js';

/** Wrap a (possibly async) handler that returns JSON. */
export const handle = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res)).then((out) => {
    if (!res.headersSent) res.json(out ?? { ok: true });
  }).catch(next);
};

/**
 * Replays the stored response when a client retries a mutation with the same Idempotency-Key
 * (e.g. after a dropped connection), so a retry can never submit twice.
 */
export const idempotent = (db, fn) => (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (key && !/^[\w-]{8,100}$/.test(key)) return next(new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid idempotency key.'));
  if (key) {
    const hit = db.prepare('SELECT status_code, response FROM idempotency_keys WHERE user_id = ? AND key = ?').get(req.user.id, key);
    if (hit) return res.status(hit.status_code).json(JSON.parse(hit.response));
  }
  let out;
  try {
    out = fn(req, res) ?? { ok: true };
  } catch (err) {
    return next(err);
  }
  if (key) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys (user_id, key, status_code, response, created_at) VALUES (?, ?, 200, ?, ?)')
      .run(req.user.id, key, JSON.stringify(out), Date.now());
  }
  res.json(out);
};

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The upload is too large.' } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed request.' } });
    }
    const dbError = err?.code?.startsWith?.('SQLITE');
    logger.error(`[${req.method} ${req.originalUrl}]`, err);
    res.status(dbError ? 503 : 500).json({
      error: dbError
        ? { code: 'DB_WRITE_FAILED', message: 'Your work could not be saved right now. It is still on this page — please try again.' }
        : { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' },
    });
  };
}
