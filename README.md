# UNIO Controlled Practice

Strict IELTS listening dictation (two full listens, no pause or seek), guided Immediate Review, 48-hour Delayed Review, remediation and teacher monitoring. Styled with the UNIO Illustration Kit.

Requires Node 20+ and `ffmpeg`/`ffprobe` on the PATH.

```bash
npm install
npm run seed:dev        # DEV ONLY: teacher/teacher-dev-pass, student1..3/student-dev-pass
npm start               # http://localhost:3000
npm test
```

Real accounts: `npm run create-user -- student <username> "<Name>" <password>`.
Data (SQLite database and audio) is stored in `./data` (override with `CP_DATA_DIR`). Migrations run on start.

## First test

1. Sign in as the teacher → **Audio Library** → upload a recording you have permission to use.
2. Open it, set start/end for a sentence (Preview selection), type the exact transcript, save, then **Verify** the clip.
3. Repeat until you have 10 verified segments, ideally from 8–10 different recordings.
4. **Test Manager** → Daily Test 01 → set mode and situation/topic, add the 10 segments, save.
5. **Assignments** → choose the Day 1 start date → Apply plan; tick the students (or "Assign every test…").
6. Back in Test Manager → **Publish**.

Settings (sentences per test, daily Guided Review limit, delayed-review cap, source target) are under **Assignments → Settings**.

## Deploying (Render)

1. New Web Service from this repo. Build `npm ci`, start `npm start`, Node 20.
2. Add a **persistent disk** mounted at `/var/data` and set `CP_DATA_DIR=/var/data`.
   Without a disk, the database and audio are wiped on every restart, deploy, or free-tier sleep.
3. Set `CP_TEACHER_USERNAME`, `CP_TEACHER_PASSWORD` (8+ characters) and optionally `CP_TEACHER_NAME`.
   The first teacher account is created from these on start-up if it does not exist yet.
4. Sign in as that teacher, add students under **Students → Add a student**, then upload audio and build tests.

`render.yaml` describes this setup as a Render Blueprint. ffmpeg/ffprobe are bundled via npm (`ffmpeg-static`, `ffprobe-static`).
