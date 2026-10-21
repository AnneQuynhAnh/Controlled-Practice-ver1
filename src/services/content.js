import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from '../db.js';
import { normalizeText } from '../lib/align.js';
import { extractClip, probeDurationMs } from '../lib/audio.js';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.js';
import { logTeacherAction } from './activity.js';
import { getSettings } from './settings.js';

export const SKILL_TAGS = ['word_recognition', 'speech_segmentation', 'connected_speech', 'information_processing'];
export const FAMILIARITY = ['previously_practised', 'unseen'];
export const DIFFICULTY = ['easy', 'medium', 'hard'];
export const MODES = ['recovery', 'training', 'transfer'];
export const RECOMMENDED_DURATION_MS = [4000, 8000];
const AUDIO_TYPES = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac',
};

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest('INVALID_NUMBER', `${name} must be a whole number of milliseconds.`);
  return n;
};
const optionalTime = (v, name) => (v === null || v === undefined || v === '' ? null : int(v, name));

// ---------------------------------------------------------------- audio sources

export async function createAudioSource(ctx, { teacherId, title, source, rightsNote, permissionConfirmed, buffer, mimeType }) {
  const { db, clock, dataDir } = ctx;
  if (!str(title)) throw badRequest('TITLE_REQUIRED', 'Enter a title for the recording.');
  if (!permissionConfirmed) {
    throw badRequest('PERMISSION_REQUIRED', 'Confirm you have permission to use this recording with your students.');
  }
  const ext = AUDIO_TYPES[String(mimeType).split(';')[0].trim().toLowerCase()];
  if (!ext) throw badRequest('UNSUPPORTED_TYPE', 'Upload an MP3, WAV, M4A, AAC, OGG, WEBM or FLAC file.');
  if (!buffer?.length) throw badRequest('EMPTY_FILE', 'The uploaded file is empty.');
  const dir = path.join(dataDir, 'audio', 'sources');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.${ext}`);
  fs.writeFileSync(file, buffer);
  let durationMs;
  try {
    durationMs = await probeDurationMs(file);
  } catch {
    fs.rmSync(file, { force: true });
    throw new HttpError(422, 'AUDIO_NOT_PLAYABLE', 'This file could not be decoded as audio.');
  }
  const now = clock.now();
  const info = db.prepare(
    `INSERT INTO audio_sources (title, source, rights_note, file_path, mime_type, duration_ms, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(str(title, 200), str(source, 300), str(rightsNote, 500), file, mimeType, durationMs, teacherId, now);
  logTeacherAction(db, now, { teacherId, action: 'upload_audio', targetType: 'audio_source', targetId: Number(info.lastInsertRowid) });
  return getAudioSource(db, Number(info.lastInsertRowid));
}

export function listAudioSources(db) {
  return db.prepare(
    `SELECT a.id, a.title, a.source, a.duration_ms, a.created_at, a.archived_at,
            (SELECT COUNT(*) FROM audio_segments s WHERE s.audio_id = a.id) AS segment_count,
            (SELECT COUNT(*) FROM audio_segments s WHERE s.audio_id = a.id AND s.verification_status = 'verified') AS verified_count
       FROM audio_sources a ORDER BY a.archived_at IS NOT NULL, a.created_at DESC`
  ).all();
}

export function getAudioSource(db, id) {
  const a = db.prepare('SELECT * FROM audio_sources WHERE id = ?').get(id);
  if (!a) throw notFound('Recording not found.');
  const { file_path: _fp, ...rest } = a;
  return { ...rest, segments: listSegments(db, { audioId: id }) };
}

export function updateAudioSource(ctx, { teacherId, id, title, source, transcript, rightsNote }) {
  const { db, clock } = ctx;
  if (!db.prepare('SELECT 1 FROM audio_sources WHERE id = ?').get(id)) throw notFound('Recording not found.');
  if (title !== undefined && !str(title)) throw badRequest('TITLE_REQUIRED', 'Title cannot be empty.');
  db.prepare(
    `UPDATE audio_sources SET title = COALESCE(?, title), source = COALESCE(?, source), transcript = COALESCE(?, transcript),
            rights_note = COALESCE(?, rights_note) WHERE id = ?`
  ).run(title === undefined ? null : str(title, 200), source === undefined ? null : str(source, 300),
    transcript === undefined ? null : String(transcript).slice(0, 100_000), rightsNote === undefined ? null : str(rightsNote, 500), id);
  logTeacherAction(db, clock.now(), { teacherId, action: 'update_audio', targetType: 'audio_source', targetId: id });
  return getAudioSource(db, id);
}

export function archiveAudioSource(ctx, { teacherId, id }) {
  const now = ctx.clock.now();
  const r = ctx.db.prepare('UPDATE audio_sources SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now, id);
  if (!r.changes) throw notFound('Recording not found.');
  logTeacherAction(ctx.db, now, { teacherId, action: 'archive_audio', targetType: 'audio_source', targetId: id });
}

export function audioSourceFile(db, id) {
  const a = db.prepare('SELECT file_path, mime_type FROM audio_sources WHERE id = ?').get(id);
  if (!a) throw notFound('Recording not found.');
  return a;
}

// ---------------------------------------------------------------- segments

function segmentRow(s) {
  return {
    segment_id: s.id, audio_id: s.audio_id, source_title: s.source_title, source_name: s.source_name, source_notes: s.source_notes,
    start_ms: s.start_ms, end_ms: s.end_ms, duration_ms: s.duration_ms, transcript: s.transcript,
    topic: s.topic, difficulty: s.difficulty, main_skill_tag: s.main_skill_tag,
    secondary_skill_tags: JSON.parse(s.secondary_skill_tags), familiarity_status: s.familiarity_status,
    verification_status: s.verification_status, verified_at: s.verified_at, has_clip: Boolean(s.clip_path),
    used_in_tests: s.used_in_tests ?? 0, in_attempts: Boolean(s.in_attempts),
    outside_recommended_duration: s.duration_ms < RECOMMENDED_DURATION_MS[0] || s.duration_ms > RECOMMENDED_DURATION_MS[1],
  };
}

export function listSegments(db, { audioId = null, verifiedOnly = false } = {}) {
  return db.prepare(
    `SELECT s.*, a.title AS source_title, a.source AS source_name, a.transcript AS source_notes,
            (SELECT COUNT(*) FROM test_items ti WHERE ti.segment_id = s.id) AS used_in_tests,
            EXISTS (SELECT 1 FROM item_attempts ia WHERE ia.segment_id = s.id) AS in_attempts
       FROM audio_segments s JOIN audio_sources a ON a.id = s.audio_id
      WHERE (? IS NULL OR s.audio_id = ?) AND (? = 0 OR s.verification_status = 'verified')
      ORDER BY s.audio_id, s.start_ms`
  ).all(audioId, audioId, verifiedOnly ? 1 : 0).map(segmentRow);
}

export function getSegment(db, id) {
  const s = db.prepare(
    `SELECT s.*, a.title AS source_title, a.source AS source_name, a.transcript AS source_notes,
            (SELECT COUNT(*) FROM test_items ti WHERE ti.segment_id = s.id) AS used_in_tests,
            EXISTS (SELECT 1 FROM item_attempts ia WHERE ia.segment_id = s.id) AS in_attempts
       FROM audio_segments s JOIN audio_sources a ON a.id = s.audio_id WHERE s.id = ?`
  ).get(id);
  if (!s) throw notFound('Segment not found.');
  return segmentRow(s);
}

function validateSegmentInput(audio, input) {
  const start = int(input.start_ms, 'Start');
  const end = int(input.end_ms, 'End');
  if (start < 0) throw badRequest('INVALID_SEGMENT', 'Start must be at or after 0:00.');
  if (end <= start) throw badRequest('INVALID_SEGMENT', 'End must be after start.');
  if (end > audio.duration_ms) throw badRequest('INVALID_SEGMENT', `End is beyond the end of the recording (${audio.duration_ms} ms).`);
  const main = input.main_skill_tag ?? 'word_recognition';
  if (!SKILL_TAGS.includes(main)) throw badRequest('INVALID_TAG', 'Choose a valid main skill.');
  const secondary = [...new Set(input.secondary_skill_tags ?? [])];
  if (secondary.some((t) => !SKILL_TAGS.includes(t))) throw badRequest('INVALID_TAG', 'Unknown secondary skill.');
  const familiarity = input.familiarity_status ?? 'unseen';
  if (!FAMILIARITY.includes(familiarity)) throw badRequest('INVALID_FAMILIARITY', 'Invalid familiarity status.');
  const difficulty = input.difficulty ?? 'medium';
  if (!DIFFICULTY.includes(difficulty)) throw badRequest('INVALID_DIFFICULTY', 'Invalid difficulty.');
  return {
    start, end, transcript: str(input.transcript, 2000), topic: str(input.topic, 200), difficulty, main,
    secondary: secondary.filter((t) => t !== main), familiarity,
  };
}

async function cutClip(dataDir, audio, start, end) {
  const dir = path.join(dataDir, 'audio', 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${crypto.randomUUID()}.mp3`);
  try {
    await extractClip(audio.file_path, start, end, out);
    await probeDurationMs(out);
  } catch {
    fs.rmSync(out, { force: true });
    throw new HttpError(422, 'INVALID_SEGMENT', 'Could not extract playable audio for these timestamps.');
  }
  return out;
}

export async function createSegment(ctx, { teacherId, audioId, input }) {
  const { db, clock, dataDir } = ctx;
  const audio = db.prepare('SELECT * FROM audio_sources WHERE id = ?').get(audioId);
  if (!audio) throw notFound('Recording not found.');
  const v = validateSegmentInput(audio, input);
  const clip = await cutClip(dataDir, audio, v.start, v.end);
  const now = clock.now();
  const info = db.prepare(
    `INSERT INTO audio_segments (audio_id, start_ms, end_ms, duration_ms, transcript, topic, difficulty, main_skill_tag,
       secondary_skill_tags, familiarity_status, clip_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(audioId, v.start, v.end, v.end - v.start, v.transcript, v.topic, v.difficulty, v.main,
    JSON.stringify(v.secondary), v.familiarity, clip, now, now);
  logTeacherAction(db, now, { teacherId, action: 'create_segment', targetType: 'audio_segment', targetId: Number(info.lastInsertRowid) });
  return getSegment(db, Number(info.lastInsertRowid));
}

export async function updateSegment(ctx, { teacherId, id, input }) {
  const { db, clock, dataDir } = ctx;
  const seg = db.prepare('SELECT * FROM audio_segments WHERE id = ?').get(id);
  if (!seg) throw notFound('Segment not found.');
  if (db.prepare('SELECT 1 FROM item_attempts WHERE segment_id = ?').get(id)) {
    throw conflict('SEGMENT_IN_USE', 'Students have already been assessed on this segment. Create a new segment instead of editing it.');
  }
  const audio = db.prepare('SELECT * FROM audio_sources WHERE id = ?').get(seg.audio_id);
  const merged = {
    start_ms: seg.start_ms, end_ms: seg.end_ms, transcript: seg.transcript, topic: seg.topic, difficulty: seg.difficulty,
    main_skill_tag: seg.main_skill_tag, secondary_skill_tags: JSON.parse(seg.secondary_skill_tags),
    familiarity_status: seg.familiarity_status, ...input,
  };
  const v = validateSegmentInput(audio, merged);
  let clip = seg.clip_path;
  if (v.start !== seg.start_ms || v.end !== seg.end_ms || !clip) {
    clip = await cutClip(dataDir, audio, v.start, v.end);
    if (seg.clip_path) fs.rmSync(seg.clip_path, { force: true });
  }
  const now = clock.now();
  // Any edit requires the teacher to verify again.
  db.prepare(
    `UPDATE audio_segments SET start_ms = ?, end_ms = ?, duration_ms = ?, transcript = ?, topic = ?, difficulty = ?, main_skill_tag = ?,
            secondary_skill_tags = ?, familiarity_status = ?, clip_path = ?, verification_status = 'draft', verified_by = NULL,
            verified_at = NULL, updated_at = ? WHERE id = ?`
  ).run(v.start, v.end, v.end - v.start, v.transcript, v.topic, v.difficulty, v.main, JSON.stringify(v.secondary),
    v.familiarity, clip, now, id);
  logTeacherAction(db, now, { teacherId, action: 'update_segment', targetType: 'audio_segment', targetId: id });
  return getSegment(db, id);
}

export async function verifySegment(ctx, { teacherId, id, overrideDuration = false }) {
  const { db, clock } = ctx;
  const seg = db.prepare('SELECT * FROM audio_segments WHERE id = ?').get(id);
  if (!seg) throw notFound('Segment not found.');
  const audio = db.prepare('SELECT * FROM audio_sources WHERE id = ?').get(seg.audio_id);
  const problems = [];
  if (!seg.transcript.trim()) problems.push('Add the transcript for this segment.');
  if (seg.start_ms < 0 || seg.end_ms > audio.duration_ms || seg.end_ms <= seg.start_ms) problems.push('Timestamps are outside the recording.');
  let playable = false;
  if (seg.clip_path && fs.existsSync(seg.clip_path)) {
    try { await probeDurationMs(seg.clip_path); playable = true; } catch { /* reported below */ }
  }
  if (!playable) problems.push('The extracted clip is not playable. Save the segment again.');
  if (problems.length) throw new HttpError(422, 'SEGMENT_INVALID', problems.join(' '), { problems });
  const outside = seg.duration_ms < RECOMMENDED_DURATION_MS[0] || seg.duration_ms > RECOMMENDED_DURATION_MS[1];
  if (outside && !overrideDuration) {
    throw new HttpError(422, 'DURATION_OUTSIDE_RECOMMENDED',
      `This segment is ${(seg.duration_ms / 1000).toFixed(1)}s. The recommended length is 4–8s. Confirm to verify anyway.`);
  }
  const now = clock.now();
  db.prepare("UPDATE audio_segments SET verification_status = 'verified', verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?")
    .run(teacherId, now, now, id);
  logTeacherAction(db, now, { teacherId, action: 'verify_segment', targetType: 'audio_segment', targetId: id, metadata: { overrideDuration: outside } });
  return getSegment(db, id);
}

export function segmentClipPath(db, id) {
  const p = db.prepare('SELECT clip_path FROM audio_segments WHERE id = ?').pluck().get(id);
  if (!p) throw notFound('Clip not found.');
  return p;
}

export function segmentExposure(db, segmentId) {
  return db.prepare(
    `SELECT u.id AS student_id, u.display_name, e.first_heard_at, e.transcript_seen_at, COALESCE(e.marked_by_teacher, 0) AS marked_by_teacher
       FROM users u LEFT JOIN student_segment_exposure e ON e.student_id = u.id AND e.segment_id = ?
      WHERE u.role = 'student' ORDER BY u.display_name`
  ).all(segmentId);
}

/** Teacher marks that a learner already practised this audio (e.g. in class). Real exposure cannot be unmarked. */
export function setExposure(ctx, { teacherId, segmentId, studentId, practised }) {
  const { db, clock } = ctx;
  const now = clock.now();
  if (practised) {
    db.prepare(
      `INSERT INTO student_segment_exposure (student_id, segment_id, marked_by_teacher) VALUES (?, ?, 1)
       ON CONFLICT (student_id, segment_id) DO UPDATE SET marked_by_teacher = 1`
    ).run(studentId, segmentId);
  } else {
    const row = db.prepare('SELECT * FROM student_segment_exposure WHERE student_id = ? AND segment_id = ?').get(studentId, segmentId);
    if (row?.first_heard_at || row?.transcript_seen_at) {
      throw conflict('ALREADY_EXPOSED', 'This student has already heard this audio or seen its transcript, so it cannot be marked unseen.');
    }
    db.prepare('DELETE FROM student_segment_exposure WHERE student_id = ? AND segment_id = ?').run(studentId, segmentId);
  }
  logTeacherAction(db, now, { teacherId, action: 'set_exposure', targetType: 'audio_segment', targetId: segmentId, studentId, metadata: { practised } });
  return segmentExposure(db, segmentId);
}

// ---------------------------------------------------------------- tests

function testRow(db, t) {
  return {
    ...t,
    vocab: JSON.parse(t.vocab_json),
    item_count: db.prepare('SELECT COUNT(*) FROM test_items WHERE test_id = ?').pluck().get(t.id),
    assigned_count: db.prepare('SELECT COUNT(*) FROM student_assignments WHERE test_id = ?').pluck().get(t.id),
    attempt_count: db.prepare('SELECT COUNT(*) FROM assessment_attempts WHERE test_id = ?').pluck().get(t.id),
  };
}

export function listTests(db) {
  return db.prepare("SELECT * FROM tests ORDER BY status = 'archived', kind = 'final', number").all().map((t) => testRow(db, t));
}

export function getTest(db, id) {
  const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  if (!t) throw notFound('Test not found.');
  const items = db.prepare(
    `SELECT ti.id AS test_item_id, ti.position, s.id AS segment_id FROM test_items ti JOIN audio_segments s ON s.id = ti.segment_id
      WHERE ti.test_id = ? ORDER BY ti.position`
  ).all(id).map((r) => ({ test_item_id: r.test_item_id, position: r.position, segment: getSegment(db, r.segment_id) }));
  const assignments = db.prepare(
    `SELECT sa.*, u.display_name FROM student_assignments sa JOIN users u ON u.id = sa.student_id WHERE sa.test_id = ? ORDER BY u.display_name`
  ).all(id);
  return { ...testRow(db, t), items, assignments };
}

const hasAttempts = (db, testId) => Boolean(db.prepare('SELECT 1 FROM assessment_attempts WHERE test_id = ?').get(testId));

/** Advisory only: items should come from several different conversations or recordings. */
export function publishWarnings(db, id) {
  const { min_sources_per_test: wanted } = getSettings(db);
  const row = db.prepare(
    // Clips cut from the same original recording share its source name, so count recordings, not files.
    `SELECT COUNT(*) AS items,
            COUNT(DISTINCT CASE WHEN a.source != '' THEN lower(a.source) ELSE 'id:' || a.id END) AS sources
       FROM test_items ti JOIN audio_segments s ON s.id = ti.segment_id JOIN audio_sources a ON a.id = s.audio_id
      WHERE ti.test_id = ?`
  ).get(id);
  const target = Math.min(wanted, row.items);
  return row.items && row.sources < target
    ? [`Sentences come from ${row.sources} recording${row.sources === 1 ? '' : 's'}. Aim for at least ${target} different sources where possible.`]
    : [];
}

/** Pre-listening vocabulary may never reveal a recognition target from the test's sentences. */
export function vocabConflicts(db, testId, vocab) {
  const transcripts = db.prepare(
    'SELECT s.transcript FROM test_items ti JOIN audio_segments s ON s.id = ti.segment_id WHERE ti.test_id = ?'
  ).pluck().all(testId).map(normalizeText);
  const words = new Set(transcripts.flat());
  const joined = transcripts.map((t) => ` ${t.join(' ')} `);
  return vocab.filter((v) => {
    const tokens = normalizeText(v);
    if (!tokens.length) return false;
    if (joined.some((j) => j.includes(` ${tokens.join(' ')} `))) return true;
    return tokens.some((tok) => tok.length >= 4 && words.has(tok));
  });
}

export function createTest(ctx, { teacherId, title, kind = 'daily', mode = 'training' }) {
  const { db, clock } = ctx;
  if (!['daily', 'final'].includes(kind)) throw badRequest('INVALID_KIND', 'Invalid test kind.');
  if (!MODES.includes(mode)) throw badRequest('INVALID_MODE', 'Invalid mode.');
  const now = clock.now();
  const number = (db.prepare('SELECT MAX(number) FROM tests WHERE kind = ?').pluck().get(kind) ?? 0) + 1;
  const name = str(title, 200) || (kind === 'final' ? 'Final Unseen-Audio Assessment' : `Daily Test ${String(number).padStart(2, '0')}`);
  const info = db.prepare(
    'INSERT INTO tests (number, kind, title, mode, plan_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(number, kind, name, kind === 'final' ? 'transfer' : mode, kind === 'final' ? 14 : null, now, now);
  logTeacherAction(db, now, { teacherId, action: 'create_test', targetType: 'test', targetId: Number(info.lastInsertRowid) });
  return getTest(db, Number(info.lastInsertRowid));
}

export function updateTest(ctx, { teacherId, id, patch }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw notFound('Test not found.');
    const next = { ...t };
    if (patch.title !== undefined) next.title = str(patch.title, 200) || t.title;
    if (patch.topic !== undefined) next.topic = str(patch.topic, 300);
    if (patch.situation !== undefined) next.situation = str(patch.situation, 300);
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) throw badRequest('INVALID_MODE', 'Invalid mode.');
      if (patch.mode !== t.mode && hasAttempts(db, id)) throw conflict('TEST_STARTED', 'Students have started this test; its mode can no longer change.');
      next.mode = patch.mode;
    }
    if (patch.shuffle_items !== undefined) {
      if (hasAttempts(db, id)) throw conflict('TEST_STARTED', 'Students have started this test.');
      next.shuffle_items = patch.shuffle_items ? 1 : 0;
    }
    if (patch.release_at !== undefined) next.release_at = optionalTime(patch.release_at, 'Release');
    if (patch.due_at !== undefined) next.due_at = optionalTime(patch.due_at, 'Due');
    if (next.release_at != null && next.due_at != null && next.due_at <= next.release_at) {
      throw badRequest('INVALID_DATES', 'The due date must be after the release date.');
    }
    let vocab = JSON.parse(t.vocab_json);
    if (patch.vocab !== undefined) {
      vocab = (Array.isArray(patch.vocab) ? patch.vocab : []).map((v) => str(v, 60)).filter(Boolean);
      if (vocab.length > 3) throw badRequest('TOO_MANY_VOCAB', 'Training mode allows at most three background vocabulary items.');
    }
    if (next.mode !== 'training') vocab = [];
    const conflicts = vocabConflicts(db, id, vocab);
    if (conflicts.length) {
      throw badRequest('VOCAB_REVEALS_TARGET', `These words appear in the test sentences and cannot be previewed: ${conflicts.join(', ')}.`, { conflicts });
    }
    const now = clock.now();
    db.prepare(
      `UPDATE tests SET title = ?, topic = ?, situation = ?, mode = ?, shuffle_items = ?, release_at = ?, due_at = ?, vocab_json = ?, updated_at = ?
        WHERE id = ?`
    ).run(next.title, next.topic, next.situation, next.mode, next.shuffle_items, next.release_at, next.due_at, JSON.stringify(vocab), now, id);
    logTeacherAction(db, now, { teacherId, action: 'update_test', targetType: 'test', targetId: id, metadata: { fields: Object.keys(patch) } });
    return getTest(db, id);
  });
}

export function setTestItems(ctx, { teacherId, id, segmentIds }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw notFound('Test not found.');
    if (hasAttempts(db, id)) throw conflict('TEST_STARTED', 'Students have started this test; its sentences are frozen.');
    if (!Array.isArray(segmentIds)) throw badRequest('INVALID_ITEMS', 'segmentIds must be a list.');
    const ids = segmentIds.map((s) => int(s, 'Segment'));
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_SEGMENT', 'A segment can appear only once in a test.');
    const { items_per_test: max } = getSettings(db);
    if (ids.length > max) throw badRequest('TOO_MANY_ITEMS', `A test has ${max} sentences (change this in Settings).`);
    for (const sid of ids) if (!db.prepare('SELECT 1 FROM audio_segments WHERE id = ?').get(sid)) throw badRequest('UNKNOWN_SEGMENT', `Segment ${sid} does not exist.`);
    db.prepare('DELETE FROM test_items WHERE test_id = ?').run(id);
    const ins = db.prepare('INSERT INTO test_items (test_id, segment_id, position) VALUES (?, ?, ?)');
    ids.forEach((sid, i) => ins.run(id, sid, i + 1));
    const now = clock.now();
    db.prepare('UPDATE tests SET updated_at = ? WHERE id = ?').run(now, id);
    logTeacherAction(db, now, { teacherId, action: 'set_test_items', targetType: 'test', targetId: id, metadata: { segmentIds: ids } });
    return getTest(db, id);
  });
}

export function publishProblems(db, id) {
  const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  const problems = [];
  const items = db.prepare(
    'SELECT s.* FROM test_items ti JOIN audio_segments s ON s.id = ti.segment_id WHERE ti.test_id = ? ORDER BY ti.position'
  ).all(id);
  const { items_per_test: required } = getSettings(db);
  if (items.length !== required) problems.push(`A test needs exactly ${required} sentences (currently ${items.length}).`);
  items.forEach((s, i) => {
    if (s.verification_status !== 'verified') problems.push(`Sentence ${i + 1} is not verified.`);
    if (!s.transcript.trim()) problems.push(`Sentence ${i + 1} has no transcript.`);
    if (!s.clip_path) problems.push(`Sentence ${i + 1} has no playable clip.`);
  });
  if (t.release_at == null || t.due_at == null) problems.push('Set the release and due dates (or apply the 14-day schedule).');
  if (t.mode === 'recovery' && !t.topic.trim()) problems.push('Recovery mode needs a general topic.');
  if (t.mode !== 'recovery' && !t.situation.trim()) problems.push('Add the situation students see before listening.');
  const conflicts = vocabConflicts(db, id, JSON.parse(t.vocab_json));
  if (conflicts.length) problems.push(`Vocabulary reveals target words: ${conflicts.join(', ')}.`);
  return problems;
}

export function setTestStatus(ctx, { teacherId, id, status }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw notFound('Test not found.');
    if (status === 'published') {
      const problems = publishProblems(db, id);
      if (problems.length) throw new HttpError(422, 'NOT_PUBLISHABLE', problems.join(' '), { problems });
    } else if (status === 'draft') {
      if (hasAttempts(db, id)) throw conflict('TEST_STARTED', 'Students have started this test. Archive it instead of unpublishing.');
    } else if (status !== 'archived') {
      throw badRequest('INVALID_STATUS', 'Invalid status.');
    }
    const now = clock.now();
    db.prepare('UPDATE tests SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    logTeacherAction(db, now, { teacherId, action: `test_${status}`, targetType: 'test', targetId: id });
    return getTest(db, id);
  });
}

// ---------------------------------------------------------------- assignments

export function listStudents(db) {
  return db.prepare("SELECT id, username, display_name, cp_paste_exception FROM users WHERE role = 'student' ORDER BY display_name").all();
}

export function assignTests(ctx, { teacherId, testIds, studentIds }) {
  const { db, clock } = ctx;
  return tx(db, () => {
    const now = clock.now();
    const ins = db.prepare('INSERT OR IGNORE INTO student_assignments (test_id, student_id, assigned_at) VALUES (?, ?, ?)');
    let created = 0;
    for (const testId of testIds) {
      if (!db.prepare("SELECT 1 FROM tests WHERE id = ? AND status != 'archived'").get(testId)) throw badRequest('UNKNOWN_TEST', `Test ${testId} not found.`);
      for (const studentId of studentIds) {
        if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'student'").get(studentId)) throw badRequest('UNKNOWN_STUDENT', `Student ${studentId} not found.`);
        created += ins.run(testId, studentId, now).changes;
      }
    }
    logTeacherAction(db, now, { teacherId, action: 'assign_tests', targetType: 'test', metadata: { testIds, studentIds, created } });
    return { created };
  });
}

export function unassign(ctx, { teacherId, assignmentId }) {
  const { db, clock } = ctx;
  const a = db.prepare('SELECT * FROM student_assignments WHERE id = ?').get(assignmentId);
  if (!a) throw notFound('Assignment not found.');
  if (db.prepare('SELECT 1 FROM assessment_attempts WHERE test_id = ? AND student_id = ?').get(a.test_id, a.student_id)) {
    throw conflict('TEST_STARTED', 'This student has started the test, so the assignment cannot be removed.');
  }
  db.prepare('DELETE FROM student_assignments WHERE id = ?').run(assignmentId);
  logTeacherAction(db, clock.now(), { teacherId, action: 'unassign', targetType: 'student_assignment', targetId: assignmentId, studentId: a.student_id });
}

export function setAssignmentWindow(ctx, { teacherId, assignmentId, releaseAt, dueAt }) {
  const { db, clock } = ctx;
  const a = db.prepare('SELECT * FROM student_assignments WHERE id = ?').get(assignmentId);
  if (!a) throw notFound('Assignment not found.');
  const r = optionalTime(releaseAt, 'Release');
  const d = optionalTime(dueAt, 'Due');
  if (r != null && d != null && d <= r) throw badRequest('INVALID_DATES', 'The due date must be after the release date.');
  db.prepare('UPDATE student_assignments SET release_at = ?, due_at = ? WHERE id = ?').run(r, d, assignmentId);
  logTeacherAction(db, clock.now(), { teacherId, action: 'set_assignment_window', targetType: 'student_assignment', targetId: assignmentId, studentId: a.student_id, metadata: { releaseAt: r, dueAt: d } });
  return db.prepare('SELECT * FROM student_assignments WHERE id = ?').get(assignmentId);
}
