// Requirements 3, 4, 5 and 23 (client side): the strict player's UI policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { prelisteningBlocks, STRICT_PLAYER_POLICY, strictUi } from '../public/js/strict-policy.js';

const plays = (used, completed, inFlight = false) => ({ used, allowed: 2, completed, inFlight });

test('initial state: 0/2, play available, writing disabled, no hints', () => {
  const ui = strictUi({ plays: plays(0, 0) });
  assert.equal(ui.counter, '0/2');
  assert.equal(ui.playEnabled, true);
  assert.equal(ui.playLabel, 'Play');
  assert.equal(ui.textareaEnabled, false);
  assert.equal(ui.submitEnabled, false);
  assert.equal(ui.showTranscript, false);
  assert.equal(ui.showWordCount, false);
});

test('input and submission are disabled during playback (req. 5)', () => {
  for (const s of [{ plays: plays(1, 0, true) }, { plays: plays(2, 1), playing: true }]) {
    const ui = strictUi(s);
    assert.equal(ui.textareaEnabled, false);
    assert.equal(ui.submitEnabled, false);
    assert.equal(ui.couldntCatchEnabled, false);
    assert.equal(ui.playEnabled, false, 'no simultaneous playback');
  }
});

test('after first play: 1/2, writing enabled, replay optional', () => {
  const ui = strictUi({ plays: plays(1, 1) });
  assert.equal(ui.counter, '1/2');
  assert.equal(ui.textareaEnabled, true);
  assert.equal(ui.playLabel, 'Replay');
  assert.equal(ui.playOptional, true);
  assert.equal(ui.playEnabled, true);
});

test('after second play: 2/2 and no more assessment playback', () => {
  const ui = strictUi({ plays: plays(2, 2) });
  assert.equal(ui.counter, '2/2');
  assert.equal(ui.playEnabled, false);
  assert.equal(ui.textareaEnabled, true);
});

test('full-sentence restrictions: no pause, seek, speed or partial playback controls (req. 3, 4)', () => {
  assert.deepEqual({ ...STRICT_PLAYER_POLICY }, {
    pause: false, seek: false, speed: false, partialPlayback: false, keyboardShortcuts: false, waveform: false,
  });
  const ui = strictUi({ plays: plays(1, 1) });
  assert.equal(ui.showPause, false);
  assert.equal(ui.showSeek, false);
  assert.equal(ui.showSpeed, false);
  // The strict player plays decoded audio through Web Audio: no <audio> element, no controls, no currentTime.
  const src = fs.readFileSync(new URL('../public/js/strict-player.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /<audio|createElement\(['"]audio|\.controls\s*=|currentTime\s*=|playbackRate/);
});

test('recovery state when both listens were interrupted', () => {
  const ui = strictUi({ plays: { used: 2, allowed: 2, completed: 0, inFlight: false } });
  assert.equal(ui.recovery, true);
  assert.equal(ui.textareaEnabled, false);
  assert.equal(ui.couldntCatchEnabled, true);
});

test('modes show different scaffolding (req. 23)', () => {
  const pre = { topic: 'T', situation: 'S', vocab: ['a', 'b', 'c', 'd'] };
  assert.deepEqual(prelisteningBlocks({ ...pre, mode: 'recovery' }), { topic: 'T', situation: null, vocab: [] });
  assert.deepEqual(prelisteningBlocks({ ...pre, mode: 'training' }), { topic: null, situation: 'S', vocab: ['a', 'b', 'c'] });
  assert.deepEqual(prelisteningBlocks({ ...pre, mode: 'transfer' }), { topic: null, situation: 'S', vocab: [] });
});
