import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { authMiddleware, csrfGuard, requireRole } from './lib/auth.js';
import { errorHandler } from './lib/http.js';
import { systemClock } from './lib/time.js';
import { authRoutes } from './routes/auth.js';
import { studentRoutes } from './routes/student.js';
import { teacherRoutes } from './routes/teacher.js';
import { repairReviewSchedules } from './services/reviews.js';
import { ensureInitialTests } from './services/schedule.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, dataDir, clock = systemClock(), logger = console }) {
  const ctx = { db, dataDir, clock };
  ensureInitialTests(db, clock.now());
  const repaired = repairReviewSchedules(db, clock.now());
  if (repaired) logger.warn(`Repaired ${repaired} review schedule(s) with a missing due time.`);

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(authMiddleware(db, clock));
  app.use('/api', express.json({ limit: '64kb' }), csrfGuard);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/cp', requireRole('student'), studentRoutes(ctx));
  app.use('/api/teacher', requireRole('teacher'), teacherRoutes(ctx));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  app.use(errorHandler(logger));
  app.locals.ctx = ctx;
  return app;
}
