import express from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { handle } from '../lib/http.js';
import * as content from '../services/content.js';
import * as monitoring from '../services/monitoring.js';
import { applySchedule, getPlan } from '../services/schedule.js';
import { getSettings, updateSettings } from '../services/settings.js';

const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
};
const ids = (v, name) => {
  if (!Array.isArray(v) || !v.length) throw badRequest('INVALID_LIST', `Choose at least one ${name}.`);
  return v.map(id);
};

export function teacherRoutes(ctx) {
  const { db } = ctx;
  const r = express.Router();
  const t = (req) => req.user.id;

  // ---------------------------------------------------------------- monitoring
  r.get('/dashboard', handle(() => monitoring.dashboard(ctx)));
  r.get('/analytics', handle(() => ({ students: monitoring.analytics(ctx) })));
  r.get('/students', handle(() => ({ students: content.listStudents(db) })));
  r.post('/students', handle((req) => monitoring.addStudent(ctx, { teacherId: t(req), ...req.body })));
  r.post('/users/:id/password', handle((req) => monitoring.resetPassword(ctx, { teacherId: t(req), userId: id(req.params.id), password: req.body?.password })));
  r.get('/students/:id', handle((req) => monitoring.studentDetail(ctx, id(req.params.id))));
  r.post('/students/:id/paste-exception', handle((req) => monitoring.setPasteException(ctx, {
    teacherId: t(req), studentId: id(req.params.id), allowed: Boolean(req.body?.allowed), reason: String(req.body?.reason ?? ''),
  })));
  r.get('/attempts/:id', handle((req) => monitoring.attemptDetail(ctx, id(req.params.id))));
  r.get('/recovery', handle(() => monitoring.recoveryQueue(ctx)));
  r.post('/restore-credit', handle((req) => monitoring.restorePlayCredit(ctx, {
    teacherId: t(req), ownerType: req.body?.ownerType, ownerId: id(req.body?.ownerId), reason: req.body?.reason,
  })));
  r.get('/reviews', handle(() => ({ items: monitoring.reviewManagement(ctx) })));
  r.post('/review-items/:id', handle((req) => monitoring.updateReviewItem(ctx, {
    teacherId: t(req), reviewItemId: id(req.params.id), ...req.body,
  })));

  // ---------------------------------------------------------------- audio library
  r.get('/audio', handle(() => ({ audio: content.listAudioSources(db) })));
  r.post('/audio', express.raw({ type: 'audio/*', limit: '200mb' }), handle((req) => content.createAudioSource(ctx, {
    teacherId: t(req),
    title: req.query.title, source: req.query.source, rightsNote: req.query.rightsNote,
    permissionConfirmed: req.query.permission === '1',
    buffer: Buffer.isBuffer(req.body) ? req.body : null,
    mimeType: req.get('Content-Type') ?? '',
  })));
  r.get('/audio/:id', handle((req) => content.getAudioSource(db, id(req.params.id))));
  r.patch('/audio/:id', handle((req) => content.updateAudioSource(ctx, { teacherId: t(req), id: id(req.params.id), ...req.body })));
  r.post('/audio/:id/archive', handle((req) => content.archiveAudioSource(ctx, { teacherId: t(req), id: id(req.params.id) })));
  r.get('/audio/:id/file', (req, res, next) => {
    try {
      const a = content.audioSourceFile(db, id(req.params.id));
      res.set('Cache-Control', 'private, no-store');
      res.type(a.mime_type);
      res.sendFile(a.file_path);
    } catch (err) { next(err); }
  });
  r.post('/audio/:id/segments', handle((req) => content.createSegment(ctx, { teacherId: t(req), audioId: id(req.params.id), input: req.body ?? {} })));
  r.get('/segments', handle((req) => ({ segments: content.listSegments(db, { verifiedOnly: req.query.verified === '1' }) })));
  r.patch('/segments/:id', handle((req) => content.updateSegment(ctx, { teacherId: t(req), id: id(req.params.id), input: req.body ?? {} })));
  r.post('/segments/:id/verify', handle((req) => content.verifySegment(ctx, {
    teacherId: t(req), id: id(req.params.id), overrideDuration: Boolean(req.body?.overrideDuration),
  })));
  r.get('/segments/:id/clip', (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      res.type('audio/mpeg');
      res.sendFile(content.segmentClipPath(db, id(req.params.id)));
    } catch (err) { next(err); }
  });
  r.get('/segments/:id/exposure', handle((req) => ({ students: content.segmentExposure(db, id(req.params.id)) })));
  r.post('/segments/:id/exposure', handle((req) => ({
    students: content.setExposure(ctx, { teacherId: t(req), segmentId: id(req.params.id), studentId: id(req.body?.studentId), practised: Boolean(req.body?.practised) }),
  })));

  // ---------------------------------------------------------------- tests + scheduling
  r.get('/tests', handle(() => ({ tests: content.listTests(db) })));
  r.post('/tests', handle((req) => content.createTest(ctx, { teacherId: t(req), ...req.body })));
  r.get('/tests/:id', handle((req) => ({ ...content.getTest(db, id(req.params.id)), problems: content.publishProblems(db, id(req.params.id)), warnings: content.publishWarnings(db, id(req.params.id)) })));
  r.patch('/tests/:id', handle((req) => content.updateTest(ctx, { teacherId: t(req), id: id(req.params.id), patch: req.body ?? {} })));
  r.put('/tests/:id/items', handle((req) => content.setTestItems(ctx, { teacherId: t(req), id: id(req.params.id), segmentIds: req.body?.segmentIds })));
  r.post('/tests/:id/status', handle((req) => content.setTestStatus(ctx, { teacherId: t(req), id: id(req.params.id), status: req.body?.status })));

  r.get('/settings', handle(() => getSettings(db)));
  r.patch('/settings', handle((req) => updateSettings(ctx, { teacherId: t(req), patch: req.body ?? {} })));
  r.get('/schedule', handle(() => getPlan(db)));
  r.post('/schedule', handle((req) => applySchedule(ctx, { teacherId: t(req), startDate: req.body?.startDate })));
  r.post('/assignments', handle((req) => content.assignTests(ctx, {
    teacherId: t(req), testIds: ids(req.body?.testIds, 'test'), studentIds: ids(req.body?.studentIds, 'student'),
  })));
  r.patch('/assignments/:id', handle((req) => content.setAssignmentWindow(ctx, {
    teacherId: t(req), assignmentId: id(req.params.id), releaseAt: req.body?.releaseAt, dueAt: req.body?.dueAt,
  })));
  r.delete('/assignments/:id', handle((req) => content.unassign(ctx, { teacherId: t(req), assignmentId: id(req.params.id) })));

  return r;
}
