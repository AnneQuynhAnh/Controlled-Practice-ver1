import path from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { ensureBootstrapTeacher } from './lib/auth.js';

const dataDir = path.resolve(process.env.CP_DATA_DIR ?? 'data');
const db = openDatabase(path.join(dataDir, 'controlled-practice.sqlite'));
const created = ensureBootstrapTeacher(db);
if (created) console.log(`Created teacher account "${created}" from CP_TEACHER_USERNAME.`);
if (!db.prepare("SELECT 1 FROM users WHERE role = 'teacher'").get()) {
  console.warn('No teacher account yet. Set CP_TEACHER_USERNAME and CP_TEACHER_PASSWORD, then restart.');
}
const app = createApp({ db, dataDir });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`UNIO Controlled Practice running at http://localhost:${port}`);
});
