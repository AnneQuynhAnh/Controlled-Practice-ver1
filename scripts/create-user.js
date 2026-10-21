// Usage: npm run create-user -- <teacher|student> <username> "<Display Name>" <password>
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createUser } from '../src/lib/auth.js';

const [role, username, displayName, password] = process.argv.slice(2);
if (!['teacher', 'student'].includes(role) || !username || !displayName || !password || password.length < 8) {
  console.error('Usage: npm run create-user -- <teacher|student> <username> "<Display Name>" <password (8+ chars)>');
  process.exit(1);
}
const db = openDatabase(path.join(path.resolve(process.env.CP_DATA_DIR ?? 'data'), 'controlled-practice.sqlite'));
createUser(db, { username, displayName, role, password });
console.log(`Created ${role} "${username}".`);
