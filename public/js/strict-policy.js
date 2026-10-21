// Pure UI policy for strict (assessment and delayed-review) listening screens.
// The server enforces the same rules; this keeps the interface from offering what the server would refuse.

export const STRICT_PLAYER_POLICY = Object.freeze({
  pause: false,
  seek: false,
  speed: false,
  partialPlayback: false,
  keyboardShortcuts: false,
  waveform: false,
});

/**
 * @param {{ plays: {used:number, allowed:number, completed:number, inFlight:boolean}, playing?: boolean,
 *           submitting?: boolean, locked?: boolean }} s
 */
export function strictUi(s) {
  const playing = Boolean(s.playing || s.plays.inFlight);
  const busy = playing || Boolean(s.submitting) || Boolean(s.locked);
  const heardOnce = s.plays.completed >= 1;
  return {
    playing,
    counter: `${Math.min(s.plays.used, s.plays.allowed)}/${s.plays.allowed}`,
    playLabel: s.plays.used === 0 ? 'Play' : 'Replay',
    playOptional: s.plays.used >= 1,
    playEnabled: !busy && s.plays.used < s.plays.allowed,
    textareaEnabled: !busy && heardOnce,
    submitEnabled: !busy && heardOnce,
    couldntCatchEnabled: !busy && s.plays.used >= 1,
    recovery: !playing && !heardOnce && s.plays.used >= s.plays.allowed,
    showPause: STRICT_PLAYER_POLICY.pause,
    showSeek: STRICT_PLAYER_POLICY.seek,
    showSpeed: STRICT_PLAYER_POLICY.speed,
    showTranscript: false,
    showWordCount: false,
  };
}

/** Scaffolding shown before listening, per mode. Mirrors the server's prelistening(). */
export function prelisteningBlocks(pre) {
  switch (pre.mode) {
    case 'recovery': return { topic: pre.topic || null, situation: null, vocab: [] };
    case 'training': return { topic: null, situation: pre.situation || null, vocab: (pre.vocab || []).slice(0, 3) };
    case 'transfer': return { topic: null, situation: pre.situation || null, vocab: [] };
    default: return { topic: null, situation: null, vocab: [] };
  }
}
