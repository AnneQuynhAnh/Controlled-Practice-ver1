import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** Bundled binaries (so hosts without ffmpeg work), overridable with CP_FFMPEG / CP_FFPROBE, else the system PATH. */
function binary(envVar, load, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const p = load();
    if (p && fs.existsSync(p)) return p;
  } catch { /* package not installed for this platform */ }
  return fallback;
}
const FFMPEG = binary('CP_FFMPEG', () => require('ffmpeg-static'), 'ffmpeg');
const FFPROBE = binary('CP_FFPROBE', () => require('ffprobe-static').path, 'ffprobe');

/** Duration in ms, or throws if ffprobe cannot decode the file (i.e. the audio is not playable). */
export async function probeDurationMs(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Audio has no decodable duration');
  return Math.round(seconds * 1000);
}

/** Re-encode exactly [startMs, endMs) into a standalone MP3 so assessments never serve the source file. */
export async function extractClip(source, startMs, endMs, out) {
  await run(FFMPEG, [
    '-v', 'error', '-y',
    '-i', source,
    '-ss', (startMs / 1000).toFixed(3),
    '-to', (endMs / 1000).toFixed(3),
    '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '4',
    '-map_metadata', '-1',
    out,
  ]);
}
