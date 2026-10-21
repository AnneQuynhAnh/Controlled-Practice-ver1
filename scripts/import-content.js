// Import pre-cut sentence clips and their transcripts into the Daily Tests.
//
// Usage: npm run import-content -- "<path to ALL_ITEMS.csv>" [--teacher=teacher]
//
// Expects the "audio-segment-studio" export layout: ALL_ITEMS.csv next to one folder per original recording.
// Each clip becomes one audio record (source = original recording) with one segment covering the whole clip.
// The CSV "script" column is the answer key. Segments are imported UNVERIFIED and tests stay unpublished:
// the teacher must listen and verify before students see anything.
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { probeDurationMs } from '../src/lib/audio.js';
import { systemClock } from '../src/lib/time.js';
import { createAudioSource, createSegment, setTestItems, updateTest } from '../src/services/content.js';
import { ensureInitialTests } from '../src/services/schedule.js';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const keys = header.map((h) => h.replace(/^﻿/, '').trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
const teacherName = (args.find((a) => a.startsWith('--teacher=')) ?? '--teacher=teacher').split('=')[1];
if (!csvPath) {
  console.error('Usage: npm run import-content -- "<path to ALL_ITEMS.csv>" [--teacher=username]');
  process.exit(1);
}
const baseDir = path.dirname(path.resolve(csvPath));
const dataDir = path.resolve(process.env.CP_DATA_DIR ?? 'data');
const db = openDatabase(path.join(dataDir, 'controlled-practice.sqlite'));
const ctx = { db, dataDir, clock: systemClock() };
ensureInitialTests(db, Date.now());
const teacherId = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'teacher'").pluck().get(teacherName);
if (!teacherId) { console.error(`No teacher account "${teacherName}".`); process.exit(1); }

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const FAMILIARITY = { practised: 'previously_practised', previously_practised: 'previously_practised' };
const report = { imported: 0, skippedExisting: 0, missingAudio: [], needsReview: [], short: 0 };
const segmentByItem = new Map();

for (const r of rows) {
  const itemId = r.item_id;
  const recording = r.source_file.split(' |')[0].replace(/\.(mp3|pdf|wav|m4a)$/i, '').trim();
  const title = `${recording} · ${itemId}`;
  const existing = db.prepare(
    'SELECT s.id FROM audio_segments s JOIN audio_sources a ON a.id = s.audio_id WHERE a.title = ?'
  ).pluck().get(title);
  if (existing) { segmentByItem.set(itemId, existing); report.skippedExisting++; continue; }
  const clip = r.clip_file && path.join(baseDir, r.clip_file);
  if (!clip || !fs.existsSync(clip)) { report.missingAudio.push(`${itemId} (${r.source_file}) — ${r.script}`); continue; }

  const audio = await createAudioSource(ctx, {
    teacherId,
    title,
    source: r.source_file,
    rightsNote: 'Imported from the teacher\'s processed audio set. Confirm permission to use with students.',
    permissionConfirmed: true,
    buffer: fs.readFileSync(clip),
    mimeType: 'audio/mpeg',
  });
  const durationMs = await probeDurationMs(clip);
  const seg = await createSegment(ctx, {
    teacherId,
    audioId: audio.id,
    input: {
      start_ms: 0,
      end_ms: Math.min(durationMs, audio.duration_ms),
      transcript: r.script,
      topic: '',
      main_skill_tag: 'word_recognition',
      familiarity_status: FAMILIARITY[r.familiarity] ?? 'unseen',
    },
  });
  db.prepare('UPDATE audio_sources SET transcript = ? WHERE id = ?').run(
    [`Answer key: ${r.script}`, r.segment_transcript && `Speech recognition heard: ${r.qa_asr_text || r.segment_transcript}`,
      r.notes && `Note: ${r.notes}`, `Original cut: ${r.start_ms}–${r.end_ms} ms`].filter(Boolean).join('\n'),
    audio.id,
  );
  segmentByItem.set(itemId, seg.segment_id);
  if (seg.duration_ms < 4000) report.short++;
  if (r.match_status !== 'matched' || Number(r.qa_similarity) < 0.8) {
    report.needsReview.push(`${itemId}: answer "${r.script}" / audio heard as "${r.qa_asr_text}" (${r.match_status}, ${r.qa_similarity})`);
  }
  report.imported++;
  process.stdout.write('.');
}
console.log();

// Place sentences into Daily Tests in CSV order; set mode from the audio's familiarity.
const byTest = new Map();
for (const r of rows) {
  if (!byTest.has(r.test_id)) byTest.set(r.test_id, []);
  byTest.get(r.test_id).push(r);
}
for (const [testKey, items] of byTest) {
  const number = Number(testKey.replace(/\D/g, ''));
  const testId = db.prepare("SELECT id FROM tests WHERE kind = 'daily' AND number = ?").pluck().get(number);
  if (!testId) { console.log(`! No Daily Test ${number}`); continue; }
  if (db.prepare('SELECT 1 FROM assessment_attempts WHERE test_id = ?').get(testId)) { console.log(`! Test ${number} already started by students — left unchanged`); continue; }
  const segIds = items.map((r) => segmentByItem.get(r.item_id)).filter(Boolean);
  setTestItems(ctx, { teacherId, id: testId, segmentIds: segIds });
  const fam = new Set(items.map((r) => FAMILIARITY[r.familiarity] ?? 'unseen'));
  const mode = fam.size > 1 ? 'training' : fam.has('previously_practised') ? 'recovery' : 'transfer';
  updateTest(ctx, { teacherId, id: testId, patch: { mode } });
  console.log(`Daily Test ${String(number).padStart(2, '0')}: ${segIds.length}/${items.length} sentences · mode ${mode}`);
}

console.log(`\nImported ${report.imported} clips (${report.skippedExisting} already present). ${report.short} are shorter than 4s.`);
if (report.missingAudio.length) console.log(`\nNo audio file for:\n  ${report.missingAudio.join('\n  ')}`);
if (report.needsReview.length) console.log(`\nListen carefully — answer key may not match the audio:\n  ${report.needsReview.join('\n  ')}`);
console.log('\nAll segments are UNVERIFIED and tests are NOT published. Listen and verify in the Audio Library / Test Manager.');
