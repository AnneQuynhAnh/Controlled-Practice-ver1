import path from 'node:path';
import { openDatabase, migrate } from '../src/db.js';

const dataDir = path.resolve(process.env.CP_DATA_DIR ?? 'data');
const db = openDatabase(path.join(dataDir, 'controlled-practice.sqlite'));
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
