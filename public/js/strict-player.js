// Strict full-sentence player for assessments, delayed reviews, self-correction and final recall.
// Audio is decoded and played through Web Audio from a single-use clip: there is no media element,
// so there are no pause, seek, speed or keyboard controls to disable. Each start is authorized by the server.
import { api, ApiError, authHeaders, interruptPlayback } from './api.js';

let audioCtx = null;

function blockMediaKeys() {
  if (!('mediaSession' in navigator)) return;
  for (const action of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'stop']) {
    try { navigator.mediaSession.setActionHandler(action, () => {}); } catch { /* unsupported action */ }
  }
}

export class StrictPlayer {
  constructor({ authorizeUrl, sessionId }) {
    this.authorizeUrl = authorizeUrl;
    this.sessionId = sessionId;
    this.token = null;
    this.source = null;
    this.playing = false;
  }

  /** Resolves when the whole sentence has played; rejects (after recording the interruption) otherwise. */
  async play() {
    if (this.playing) throw new Error('Already playing');
    // Create/resume the audio context synchronously inside the click gesture.
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const resumed = audioCtx.resume();
    blockMediaKeys();
    this.playing = true;
    let auth;
    try {
      auth = await api('POST', this.authorizeUrl, { sessionId: this.sessionId });
    } catch (err) {
      this.playing = false;
      throw err;
    }
    this.token = auth.token;
    try {
      const res = await fetch(auth.clipUrl, { credentials: 'same-origin', cache: 'no-store', headers: authHeaders() });
      if (!res.ok) throw new Error(`clip ${res.status}`);
      const buffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
      await resumed;
      await new Promise((resolve, reject) => {
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        this.source = src;
        this.rejectPlay = reject;
        src.onended = () => (this.source === src ? resolve() : undefined);
        src.start();
      });
    } catch (err) {
      this.cleanup();
      if (!(err instanceof InterruptedError)) interruptPlayback(auth.token, 'load_error');
      throw err instanceof InterruptedError ? err : new PlaybackError('The audio could not be played. This listen has been recorded as interrupted.');
    }
    this.source = null;
    // The server only credits completion after the clip's full duration has elapsed.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api('POST', `/api/cp/playback/${auth.token}/complete`, {}, { retries: 2 });
        break;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PLAY_TOO_EARLY' && attempt < 3) {
          await new Promise((r) => setTimeout(r, 700));
          continue;
        }
        this.cleanup();
        throw err;
      }
    }
    this.cleanup();
    return auth;
  }

  /** Stop immediately (tab hidden, navigation). The start remains counted on the server. */
  interrupt(reason) {
    if (!this.playing) return;
    const token = this.token;
    const src = this.source;
    this.source = null;
    try { src?.stop(); } catch { /* not started */ }
    interruptPlayback(token, reason);
    this.rejectPlay?.(new InterruptedError(reason));
    this.cleanup();
  }

  cleanup() {
    this.playing = false;
    this.source = null;
    this.rejectPlay = null;
  }
}

export class InterruptedError extends Error {}
export class PlaybackError extends Error {}
