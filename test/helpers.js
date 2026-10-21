// Test harness. Audio here is a generated sine tone and transcripts are placeholder fixture strings:
// they exercise the system and are not learning content.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { createUser } from '../src/lib/auth.js';
import { dayStart, fakeClock, HOUR } from '../src/lib/time.js';

export const START_DATE = '2026-11-02';
export const FIXTURE_SENTENCES = [
  'fixture sentence number one',
  'fixture sentence number two',
  'fixture sentence number three',
  'fixture sentence number four',
  'fixture sentence number five',
  'fixture sentence number six',
  'fixture sentence number seven',
  'fixture sentence number eight',
  'fixture sentence number nine',
  'fixture sentence number ten',
];

let toneFile;
function tone() {
  if (toneFile) return toneFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tone-'));
  toneFile = path.join(dir, 'tone.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-ac', '1', '-ar', '16000', toneFile]);
  return toneFile;
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }

  async req(method, url, body, headers = {}) {
    const isBuffer = Buffer.isBuffer(body);
    const res = await fetch(this.base + url, {
      method,
      headers: {
        ...(isBuffer ? {} : { 'Content-Type': 'application/json' }),
        'X-CP-Client': '1',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuffer ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }

  get(url, headers) { return this.req('GET', url, undefined, headers); }
  post(url, body = {}, headers) { return this.req('POST', url, body, headers); }
  patch(url, body = {}) { return this.req('PATCH', url, body); }
  put(url, body = {}) { return this.req('PUT', url, body); }
}

export async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  const db = openDatabase(':memory:');
  // 09:00 on plan day 1 in Asia/Ho_Chi_Minh.
  const clock = fakeClock(dayStart(START_DATE) + 9 * HOUR);
  const quiet = { error() {}, warn() {}, log() {} };
  const app = createApp({ db, dataDir, clock, logger: quiet });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = {
    teacher: createUser(db, { username: 'teacher', displayName: 'Teacher', role: 'teacher', password: 'teacher-pass' }),
    s1: createUser(db, { username: 's1', displayName: 'Student A', role: 'student', password: 'student-pass' }),
    s2: createUser(db, { username: 's2', displayName: 'Student B', role: 'student', password: 'student-pass' }),
    s3: createUser(db, { username: 's3', displayName: 'Student C', role: 'student', password: 'student-pass' }),
  };
  const login = async (username, password) => {
    const c = new Client(base);
    const r = await c.post('/api/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    return c;
  };
  const world = {
    db, clock, dataDir, server, base, users,
    teacher: await login('teacher', 'teacher-pass'),
    s1: await login('s1', 'student-pass'),
    s2: await login('s2', 'student-pass'),
    s3: await login('s3', 'student-pass'),
    close: () => new Promise((r) => server.close(r)),
  };
  return world;
}

export async function uploadTone(w, title = 'Fixture tone') {
  const r = await w.teacher.req('POST', `/api/teacher/audio?title=${encodeURIComponent(title)}&source=fixture&permission=1`,
    fs.readFileSync(tone()), { 'Content-Type': 'audio/wav' });
  if (r.status !== 200) throw new Error(`upload failed ${JSON.stringify(r.data)}`);
  return r.data;
}

/** Create, verify and attach six 5-second segments to a test; schedule, publish and assign it. */
export async function publishTest(w, { testNumber = 1, mode = 'training', sentences = FIXTURE_SENTENCES, offsetSec = 0, students = ['s1', 's2', 's3'], extra = {} } = {}) {
  const audio = await uploadTone(w);
  const segmentIds = [];
  for (let i = 0; i < sentences.length; i++) {
    const start = (offsetSec + i * 6) * 1000;
    const r = await w.teacher.post(`/api/teacher/audio/${audio.id}/segments`, {
      start_ms: start, end_ms: start + 5000, transcript: sentences[i], topic: 'fixture',
      main_skill_tag: 'word_recognition', familiarity_status: extra.familiarity ?? 'unseen',
    });
    if (r.status !== 200) throw new Error(`segment failed ${JSON.stringify(r.data)}`);
    const v = await w.teacher.post(`/api/teacher/segments/${r.data.segment_id}/verify`, {});
    if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.data)}`);
    segmentIds.push(r.data.segment_id);
  }
  const testId = w.db.prepare("SELECT id FROM tests WHERE number = ? AND kind = 'daily'").pluck().get(testNumber);
  const items = await w.teacher.put(`/api/teacher/tests/${testId}/items`, { segmentIds });
  if (items.status !== 200) throw new Error(JSON.stringify(items.data));
  const sched = await w.teacher.get('/api/teacher/schedule');
  if (!sched.data.startDate) await w.teacher.post('/api/teacher/schedule', { startDate: START_DATE });
  const patch = await w.teacher.patch(`/api/teacher/tests/${testId}`, { mode, topic: 'Fixture topic', situation: 'Fixture situation', ...(extra.patch ?? {}) });
  if (patch.status !== 200) throw new Error(JSON.stringify(patch.data));
  const pub = await w.teacher.post(`/api/teacher/tests/${testId}/status`, { status: 'published' });
  if (pub.status !== 200) throw new Error(`publish failed ${JSON.stringify(pub.data)}`);
  const studentIds = students.map((s) => w.users[s]);
  const asg = await w.teacher.post('/api/teacher/assignments', { testIds: [testId], studentIds });
  if (asg.status !== 200) throw new Error(JSON.stringify(asg.data));
  return { testId, segmentIds, audioId: audio.id };
}

export async function start(client, testId, resumeFrom) {
  const r = await client.post(`/api/cp/tests/${testId}/start`, { resumeFrom });
  if (r.status !== 200) throw new Error(`start failed ${JSON.stringify(r.data)}`);
  const state = await client.get(`/api/cp/attempts/${r.data.attemptId}`);
  return { ...r.data, state: state.data };
}

/** Authorize, download and finish one full playback, advancing the fake clock by the clip length. */
export async function playFull(w, client, url, sessionId) {
  const auth = await client.post(url, { sessionId });
  if (auth.status !== 200) return auth;
  const clip = await client.get(auth.data.clipUrl);
  if (clip.status !== 200) throw new Error(`clip ${clip.status}`);
  w.clock.advance(auth.data.durationMs + 100);
  const done = await client.post(`/api/cp/playback/${auth.data.token}/complete`);
  if (done.status !== 200) throw new Error(`complete ${JSON.stringify(done.data)}`);
  return auth;
}

export const itemPlayUrl = (attemptId, itemId) => `/api/cp/attempts/${attemptId}/items/${itemId}/play`;

/** Answer every sentence of a started attempt. answers[i] is text, or null for "couldn't catch it". */
export async function completeTest(w, client, attemptId, sessionId, answers) {
  let last;
  for (let i = 0; i < answers.length; i++) {
    const st = await client.get(`/api/cp/attempts/${attemptId}`);
    const item = st.data.item;
    await playFull(w, client, itemPlayUrl(attemptId, item.id), sessionId);
    last = await client.post(`/api/cp/attempts/${attemptId}/items/${item.id}/submit`, {
      sessionId, text: answers[i] ?? '', couldntCatch: answers[i] === null,
    });
    if (last.status !== 200) throw new Error(`submit ${JSON.stringify(last.data)}`);
  }
  return last.data;
}

/** The transcript for the item currently shown to a student (read from the DB, as a test oracle). */
export function transcriptFor(w, itemAttemptId) {
  return w.db.prepare('SELECT s.transcript FROM item_attempts ia JOIN audio_segments s ON s.id = ia.segment_id WHERE ia.id = ?').pluck().get(itemAttemptId);
}

/** Run the four immediate-review stages for a review item. */
export async function runReview(w, client, reviewItemId, { selfText = 'x', recallText = 'x' } = {}) {
  const st = await client.post(`/api/cp/reviews/${reviewItemId}/start`, {});
  if (st.status !== 200) throw new Error(`review start ${JSON.stringify(st.data)}`);
  const { reviewAttemptId: ra, sessionId } = st.data;
  const base = `/api/cp/review-attempts/${ra}`;
  let r = await client.post(`${base}/self-correction`, { sessionId, text: selfText });
  if (r.status !== 200) throw new Error(`self ${JSON.stringify(r.data)}`);
  r = await client.post(`${base}/advance`, { sessionId, from: 'feedback' });
  r = await client.post(`${base}/advance`, { sessionId, from: 'guided' });
  await playFull(w, client, `${base}/play`, sessionId);
  r = await client.post(`${base}/final-recall`, { sessionId, text: recallText });
  if (r.status !== 200) throw new Error(`recall ${JSON.stringify(r.data)}`);
  return { reviewAttemptId: ra, sessionId, result: r.data };
}

export async function runDelayed(w, client, reviewItemId, text) {
  const st = await client.post(`/api/cp/reviews/${reviewItemId}/start`, {});
  if (st.status !== 200) return st;
  const { reviewAttemptId: ra, sessionId } = st.data;
  await playFull(w, client, `/api/cp/review-attempts/${ra}/play`, sessionId);
  const r = await client.post(`/api/cp/review-attempts/${ra}/delayed-submit`, { sessionId, text });
  return { ...r, reviewAttemptId: ra, sessionId };
}
