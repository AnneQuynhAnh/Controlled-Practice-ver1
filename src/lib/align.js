// Word-level normalization and alignment for dictation scoring.
// Capitalization and punctuation are ignored; every lexical difference is kept.

// Spelling variants of the same words. Reduced forms (gonna, wanna) are NOT merged: hearing them is a listening skill.
const SPELLING_VARIANTS = [
  [/\balright\b/g, 'all right'],
  [/\bokay\b/g, 'ok'],
  [/\bo\.k\.?/g, 'ok'],
];

export function normalizeText(text) {
  let t = String(text ?? '').toLowerCase();
  for (const [re, to] of SPELLING_VARIANTS) t = t.replace(re, to);
  return t
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—-]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

function charDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** A substitution close in spelling to the target; flagged as "possible spelling", never as a diagnosis. */
export function isPossibleSpelling(expected, heard) {
  if (!expected || !heard || expected === heard) return false;
  const d = charDistance(expected, heard);
  const longest = Math.max(expected.length, heard.length);
  return longest >= 3 && d <= Math.max(1, Math.floor(longest / 4));
}

// Substituting similar words costs a little less than substituting unrelated ones, so among equally short
// alignments the one that pairs "librery" with "library" wins. Still always cheaper than delete + insert.
function subCost(a, b) {
  return 1 + 0.5 * (charDistance(a, b) / Math.max(a.length, b.length));
}

const EPS = 1e-9;

/** Levenshtein alignment over word tokens. Returns ops: match | sub | del (missing) | ins (extra). */
export function alignWords(refTokens, hypTokens) {
  const n = refTokens.length;
  const m = hypTokens.length;
  const cost = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const diag = (i, j) => (refTokens[i - 1] === hypTokens[j - 1] ? 0 : subCost(refTokens[i - 1], hypTokens[j - 1]));
  for (let i = 0; i <= n; i++) cost[i][0] = i;
  for (let j = 0; j <= m; j++) cost[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cost[i][j] = Math.min(cost[i - 1][j - 1] + diag(i, j), cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && Math.abs(cost[i][j] - (cost[i - 1][j - 1] + diag(i, j))) < EPS) {
      const same = refTokens[i - 1] === hypTokens[j - 1];
      ops.push({ op: same ? 'match' : 'sub', ref: refTokens[i - 1], hyp: hypTokens[j - 1] });
      i--; j--;
    } else if (i > 0 && Math.abs(cost[i][j] - (cost[i - 1][j] + 1)) < EPS) {
      ops.push({ op: 'del', ref: refTokens[i - 1], hyp: null });
      i--;
    } else {
      ops.push({ op: 'ins', ref: null, hyp: hypTokens[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

export function scoreAnswer(reference, answer) {
  const ref = normalizeText(reference);
  const hyp = normalizeText(answer);
  const ops = alignWords(ref, hyp);
  const count = (op) => ops.filter((o) => o.op === op).length;
  const hits = count('match');
  const subs = count('sub');
  const dels = count('del');
  const ins = count('ins');
  const wordAccuracy = ref.length ? Math.max(0, (ref.length - subs - dels - ins) / ref.length) : 0;
  return {
    refWordCount: ref.length,
    hits, subs, dels, ins,
    wordAccuracy: Math.round(wordAccuracy * 1000) / 1000,
    exact: ref.length > 0 && hits === ref.length && subs + dels + ins === 0,
    ops: ops.map((o) => (o.op === 'sub' ? { ...o, possibleSpelling: isPossibleSpelling(o.ref, o.hyp) } : o)),
    missing: ops.filter((o) => o.op === 'del').map((o) => o.ref),
    extra: ops.filter((o) => o.op === 'ins').map((o) => o.hyp),
    substituted: ops.filter((o) => o.op === 'sub').map((o) => ({ expected: o.ref, heard: o.hyp, possibleSpelling: isPossibleSpelling(o.ref, o.hyp) })),
  };
}
