import assert from 'node:assert/strict';
import test from 'node:test';
import { isPossibleSpelling, normalizeText, scoreAnswer } from '../src/lib/align.js';

test('normalization ignores capitalization and punctuation but keeps words', () => {
  assert.deepEqual(normalizeText('The Library, opens at Nine!'), ['the', 'library', 'opens', 'at', 'nine']);
  assert.deepEqual(normalizeText("It’s  well-known."), ["it's", 'well', 'known']);
});

test('exact match ignores case and terminal punctuation', () => {
  const s = scoreAnswer('The library opens at nine.', 'the library opens at nine');
  assert.equal(s.exact, true);
  assert.equal(s.wordAccuracy, 1);
});

test('word alignment reports missing, extra and substituted words', () => {
  const s = scoreAnswer('the library opens at nine', 'the librery open at at nine');
  assert.equal(s.exact, false);
  assert.deepEqual(s.extra, ['at']);
  assert.equal(s.substituted.length, 2);
  const lib = s.substituted.find((x) => x.expected === 'library');
  assert.equal(lib.heard, 'librery');
  assert.equal(lib.possibleSpelling, true);
  const missing = scoreAnswer('the library opens at nine', 'the library at nine');
  assert.deepEqual(missing.missing, ['opens']);
});

test('meaningful lexical differences are not treated as spelling', () => {
  assert.equal(isPossibleSpelling('fifteen', 'fifty'), false);
  assert.equal(scoreAnswer('fifteen people', 'fifty people').exact, false);
});

test('blank answers score zero', () => {
  const s = scoreAnswer('one two three', '');
  assert.equal(s.wordAccuracy, 0);
  assert.equal(s.missing.length, 3);
});

test('spelling variants count as the same words, reduced forms do not', () => {
  assert.equal(scoreAnswer('All right. I’ll turn it off.', "Alright, I'll turn it off").exact, true);
  assert.equal(scoreAnswer('Okay, see you.', 'OK see you').exact, true);
  assert.equal(scoreAnswer('We’re going to go surfing.', "we're gonna go surfing").exact, false);
});
