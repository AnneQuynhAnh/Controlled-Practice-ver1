// DEVELOPMENT FIXTURES ONLY. Creates a teacher and three student accounts with known passwords.
// It creates no audio, transcripts or questions: learning content is added by the teacher.
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createUser } from '../src/lib/auth.js';
import { ensureInitialTests } from '../src/services/schedule.js';

const db = openDatabase(path.join(path.resolve(process.env.CP_DATA_DIR ?? 'data'), 'controlled-practice.sqlite'));
const fixtures = [
  ['teacher', 'teacher', 'Teacher (dev)', 'teacher-dev-pass'],
  ['student', 'student1', 'Student 1 (dev)', 'student-dev-pass'],
  ['student', 'student2', 'Student 2 (dev)', 'student-dev-pass'],
  ['student', 'student3', 'Student 3 (dev)', 'student-dev-pass'],
];
for (const [role, username, displayName, password] of fixtures) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) continue;
  createUser(db, { role, username, displayName, password });
  console.log(`[dev fixture] ${role} ${username} / ${password}`);
}
ensureInitialTests(db, Date.now());
console.log('Ten empty Daily Test records are in place. Add audio and sentences from the teacher area.');
