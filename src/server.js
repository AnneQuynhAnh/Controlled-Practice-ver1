import path from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';

const dataDir = path.resolve(process.env.CP_DATA_DIR ?? 'data');
const db = openDatabase(path.join(dataDir, 'controlled-practice.sqlite'));
const app = createApp({ db, dataDir });
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`UNIO Controlled Practice running at http://localhost:${port}`);
});
