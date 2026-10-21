import { ApiError, get, localDraft, post, tabSession } from '../api.js';
import { guardAnswerBox, monitorSession, playPanel, returnOverlay, sessionTakenOver } from '../listening.js';
import { InterruptedError, StrictPlayer } from '../strict-player.js';
import { prelisteningBlocks, strictUi } from '../strict-policy.js';
import { confirmModal, emptyState, errorView, html, IMG, modeBadge, pct, setHtml, toast } from '../ui.js';
import { diffView } from './review.js';

const INSTRUCTION = 'Listen to the complete sentence and type what you hear.';

export async function testPage(root, [testIdStr]) {
  const testId = Number(testIdStr);
  const { tests } = await get('/api/cp/tests');
  const card = tests.find((t) => t.id === testId);
  if (!card) return setHtml(root, emptyState(IMG.huh, 'Test not found', 'This test is not assigned to you.'));
  if (card.status === 'locked') return setHtml(root, emptyState(IMG.sleepy, 'Not open yet', 'This test has not been released.'));
  root.classList.add('narrow');

  if (!card.attemptId) {
    // Explain the rules and monitoring before the attempt exists.
    setHtml(root, html`
      <div class="lesson stack">
        <div class="row" style="justify-content:space-between">
          <div><span class="eyebrow">${card.kind === 'final' ? 'Final assessment' : `Daily Test ${String(card.number).padStart(2, '0')}`}</span><h1>${card.title}</h1></div>
          <img src="${IMG.listening}" alt="" width="100" height="100">
        </div>
        <div class="row">${modeBadge(card.mode)}<span class="badge">${card.itemCount} sentences</span></div>
        <div class="card flat stack-sm">
          <h3>How this test works</h3>
          <ul style="padding-left:18px" class="stack-sm">
            <li>Each sentence plays <strong>in full</strong>. You can't pause, skip back or change the speed.</li>
            <li>You have <strong>two listens</strong> per sentence. The second is optional.</li>
            <li>Write after the first listen. The box is locked while audio plays.</li>
            <li>Once you press <strong>Submit &amp; Next</strong>, that sentence is locked. You can't go back.</li>
            <li>You'll see your results after the last sentence.</li>
          </ul>
          <h3 style="margin-top:12px">What is recorded</h3>
          <ul style="padding-left:18px" class="stack-sm small">
            <li>Your answers, when you play the audio, and how long you spend.</li>
            <li>When you leave this tab (the audio stops, and that listen still counts) and when you come back.</li>
            <li>Paste is turned off, and attempts to paste are noted. Your clipboard is never read.</li>
            <li>Opening the test in two places at once is noted.</li>
          </ul>
          <p class="small muted">Your teacher uses this to understand your practice, not to accuse you. If the audio fails, your teacher can give a listen back.</p>
        </div>
        <button class="btn btn-primary btn-block" data-start>I understand — start</button>
      </div>`);
    await new Promise((resolve) => root.querySelector('[data-start]').addEventListener('click', resolve, { once: true }));
  }
  return runAttempt(root, testId);
}

/** Redo a finished test as practice. Same listening rules; the original score never changes. */
export async function redoPage(root, [testIdStr]) {
  const testId = Number(testIdStr);
  const { tests } = await get('/api/cp/tests');
  const card = tests.find((t) => t.id === testId);
  if (!card?.submittedAt) return setHtml(root, emptyState(IMG.unsure, 'Finish the test first', 'You can redo a test after you have submitted it once.'));
  root.classList.add('narrow');
  if (!card.practice.inProgress) {
    setHtml(root, html`
      <div class="lesson stack">
        <div><span class="eyebrow">Redo test · practice</span><h1>${card.title}</h1></div>
        <div class="card flat stack-sm">
          <p>Take the whole test again to see how much you remember. The rules are the same: <strong>two full listens</strong> per sentence, no pause or rewind.</p>
          <p><strong>Your first score stays as it is.</strong> This redo is saved separately so you can compare.</p>
          <p class="small muted">The same monitoring applies (leaving the page, copy/paste).</p>
        </div>
        <button class="btn btn-primary btn-block" data-start>Start redo</button>
      </div>`);
    await new Promise((resolve) => root.querySelector('[data-start]').addEventListener('click', resolve, { once: true }));
  }
  return runAttempt(root, testId, { practice: true });
}

async function runAttempt(root, testId, { practice = false } = {}) {
  const scope = `${practice ? 'redo' : 'test'}:${testId}`;
  let session;
  try {
    session = await post(`/api/cp/tests/${testId}/${practice ? 'practice/start' : 'start'}`, { resumeFrom: tabSession.get(scope) });
  } catch (err) {
    return setHtml(root, errorView(err));
  }
  if (session.submitted) return showSummary(root, session.attemptId);
  tabSession.set(scope, session.sessionId);
  const { attemptId, sessionId } = session;

  let state = await get(`/api/cp/attempts/${attemptId}`);
  let player = null;
  let playing = false;
  let submitting = false;
  let saveTimer = null;
  let saveState = '';
  let stopped = false;

  const draftKey = () => `${attemptId}:${state.item.id}`;
  const textarea = () => root.querySelector('textarea.answer');

  const stopMonitor = monitorSession({
    sessionId,
    getPlayer: () => player,
    describe: () => (submitting ? 'submitting' : 'writing'),
    onReturn: async (hiddenMs) => {
      const wasPlaying = playing;
      await returnOverlay(hiddenMs, { wasPlaying });
      await refresh();
    },
  });

  async function refresh() {
    try {
      state = await get(`/api/cp/attempts/${attemptId}`);
    } catch (err) { return handleError(err); }
    if (state.attempt.status === 'submitted') return finish();
    render();
  }

  function finish() {
    stopped = true;
    stopMonitor();
    showSummary(root, attemptId);
  }

  function handleError(err) {
    if (err instanceof ApiError && (err.code === 'SESSION_SUPERSEDED' || err.code === 'SESSION_INVALID')) {
      stopMonitor();
      stopped = true;
      sessionTakenOver(() => runAttempt(root, testId, { practice }));
      return;
    }
    toast(err.message, 'error');
  }

  function statusText(ui) {
    const it = state.item;
    if (ui.playing) return 'Listening… the answer box opens when the sentence ends.';
    if (ui.recovery) return '';
    if (it.plays.used === 0) return INSTRUCTION;
    if (it.plays.used < it.plays.allowed) return 'Write what you heard. You may replay once more.';
    return 'No listens left. Check your answer, then submit.';
  }

  function render() {
    const it = state.item;
    const ui = strictUi({ plays: it.plays, playing, submitting });
    const pre = prelisteningBlocks(state.test.prelistening);
    const last = state.attempt.currentPosition >= state.attempt.itemCount;
    // Keep unsaved typing across re-renders of the same sentence only.
    const current = root.dataset.itemId === String(it.id) ? textarea()?.value : undefined;
    const draft = current ?? (it.draft || (localDraft.get(draftKey())?.text ?? ''));
    setHtml(root, html`
      <div class="lesson">
        <div class="assess-top">
          <div>
            <span class="eyebrow">${state.test.title}${state.attempt.kind === 'practice' ? ` · Redo ${state.attempt.practiceNo}` : ''}</span>
            <h2>Sentence ${it.position} <span class="muted" style="font-weight:600">of ${state.attempt.itemCount}</span></h2>
          </div>
          <div class="progress-dots" aria-hidden="true">
            ${Array.from({ length: state.attempt.itemCount }, (_, i) => html`<i class="${i + 1 < it.position ? 'done' : i + 1 === it.position ? 'current' : ''}"></i>`)}
          </div>
        </div>
        ${pre.topic || pre.situation || pre.vocab.length ? html`
          <div class="card flat small" style="margin-bottom:12px">
            ${pre.topic ? html`<div><strong>Topic:</strong> ${pre.topic}</div>` : ''}
            ${pre.situation ? html`<div><strong>Situation:</strong> ${pre.situation}</div>` : ''}
            ${pre.vocab.length ? html`<div><strong>Background words:</strong> ${pre.vocab.join(' · ')}</div>` : ''}
          </div>` : ''}
        ${ui.recovery ? html`
          <div class="banner coral" role="alert">
            <img src="${IMG.sorry}" alt="">
            <div><strong>The audio didn't play completely.</strong>
            Both listens were interrupted, so they've been recorded as a technical problem — not as a mistake.
            Ask your teacher to give you a listen back, or choose “I couldn't catch it” to continue.
            <div style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-refresh>Check again</button></div></div>
          </div>` : ''}
        ${playPanel(ui, { statusText: statusText(ui) })}
        <label class="sr-only" for="answer">Your answer for sentence ${it.position}</label>
        <textarea id="answer" class="answer" ${ui.textareaEnabled ? '' : 'disabled'}
          placeholder="${ui.textareaEnabled ? 'Type the whole sentence…' : 'The answer box opens after the first full listen.'}">${draft}</textarea>
        <p class="hint" data-paste-note hidden>Copy and paste are turned off during the test.</p>
        <div class="assess-actions">
          <button class="link-btn" data-couldnt ${ui.couldntCatchEnabled ? '' : 'disabled'}>I couldn't catch it</button>
          <span class="save-state" aria-live="polite">${saveState}</span>
          <button class="btn btn-primary" data-submit ${ui.submitEnabled ? '' : 'disabled'}>${last ? 'Submit & Finish' : 'Submit & Next'}</button>
        </div>
      </div>`);
    root.dataset.itemId = String(it.id);
    const ta = textarea();
    guardAnswerBox(ta, { sessionId, allowPaste: state.pasteException });
    ta.addEventListener('input', () => {
      localDraft.set(draftKey(), ta.value);
      saveState = 'Saving…';
      root.querySelector('.save-state').textContent = saveState;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDraft, 1200);
    });
    ta.addEventListener('focus', () => setTimeout(() => ta.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300));
    root.querySelector('[data-action="play"]').addEventListener('click', onPlay);
    root.querySelector('[data-submit]').addEventListener('click', () => onSubmit(false));
    root.querySelector('[data-couldnt]').addEventListener('click', () => onSubmit(true));
    root.querySelector('[data-refresh]')?.addEventListener('click', refresh);
    if (ui.textareaEnabled && !playing) ta.focus();
  }

  async function saveDraft() {
    const ta = textarea();
    if (!ta || ta.disabled || stopped) return;
    try {
      await post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/draft`, { sessionId, text: ta.value });
      saveState = 'Draft saved';
    } catch (err) {
      saveState = 'Saved on this device only';
      if (err.code === 'SESSION_SUPERSEDED') handleError(err);
    }
    const el = root.querySelector('.save-state');
    if (el) el.textContent = saveState;
  }

  async function onPlay() {
    if (playing) return;
    clearTimeout(saveTimer);
    if (!textarea().disabled) await saveDraft();
    player = new StrictPlayer({ authorizeUrl: `/api/cp/attempts/${attemptId}/items/${state.item.id}/play`, sessionId });
    playing = true;
    state.item.plays = { ...state.item.plays, used: state.item.plays.used + 1, inFlight: true };
    render();
    try {
      await player.play();
    } catch (err) {
      if (!(err instanceof InterruptedError)) handleError(err);
    } finally {
      playing = false;
      player = null;
    }
    if (!stopped) await refresh();
  }

  async function onSubmit(couldntCatch) {
    const ta = textarea();
    const text = ta.value;
    const last = state.attempt.currentPosition >= state.attempt.itemCount;
    if (couldntCatch) {
      const ok = await confirmModal({ title: "Submit without an answer?", body: "This sentence will be locked as “I couldn't catch it”. You can work on it in the review afterwards.", confirmLabel: 'Submit blank', img: IMG.unsure });
      if (!ok) return;
    } else if (!text.trim() || last) {
      const ok = await confirmModal({
        title: last ? 'Finish the test?' : 'Submit an empty answer?',
        body: last ? 'Your answers will be locked and you will see your results.' : 'This sentence will be locked. You cannot come back to it.',
        confirmLabel: last ? 'Submit & Finish' : 'Submit',
        img: last ? IMG.congrats : IMG.unsure,
      });
      if (!ok) return;
    }
    submitting = true;
    clearTimeout(saveTimer);
    render();
    try {
      const r = await post(`/api/cp/attempts/${attemptId}/items/${state.item.id}/submit`, { sessionId, text, couldntCatch }, { idempotent: true });
      localDraft.clear(draftKey());
      submitting = false;
      if (r.finished) return finish();
      state = await get(`/api/cp/attempts/${attemptId}`);
      render();
    } catch (err) {
      submitting = false;
      if (err.code === 'ALREADY_SUBMITTED' || err.code === 'NOT_CURRENT_ITEM') return refresh();
      render();
      handleError(err);
    }
  }

  render();
  return () => {
    stopped = true;
    player?.interrupt('navigated_away');
    clearTimeout(saveTimer);
    stopMonitor();
  };
}

async function showSummary(root, attemptId) {
  const [state, queue] = await Promise.all([get(`/api/cp/attempts/${attemptId}`), get('/api/cp/queue')]);
  const s = state.summary;
  if (s.practice) return showPracticeSummary(root, state);
  const waiting = new Set(queue.pendingRemediation.map((r) => r.id));
  const firstReview = s.items.find((i) => i.reviewItemId && !waiting.has(i.reviewItemId) && ['immediate_pending', 'immediate_in_progress'].includes(i.reviewStatus));
  setHtml(root, html`
    <section class="hero">
      <div>
        <span class="eyebrow">${state.test.title} · submitted</span>
        <h1>${s.exactCount} of ${s.itemCount} sentences correct</h1>
        <p>Independent word accuracy: <strong>${pct(s.wordAccuracy)}</strong>. These answers are locked and are your independent score.</p>
      </div>
      <img src="${s.exactCount === s.itemCount ? IMG.congrats : IMG.writing}" alt="">
    </section>
    ${firstReview ? html`
      <div class="banner blue"><img src="${IMG.writing}" alt="">
        <div><strong>Next: Immediate Review</strong> Work through the sentences you missed while they're fresh. Today is best.
        ${waiting.size ? html`<div class="small">Up to ${queue.guidedLimit} a day — ${waiting.size} will wait for the next days.</div>` : ''}
        <div style="margin-top:10px"><a class="btn btn-blue" href="#/review/${firstReview.reviewItemId}">Start Immediate Review</a></div></div>
      </div>` : ''}
    <ol class="stack-sm" style="list-style:none;margin-top:16px">
      ${s.items.map((i) => html`
        <li class="review-item">
          <div class="what">
            <strong>Sentence ${i.position}</strong>
            <span class="${i.answer ? '' : 'muted'}">${i.couldntCatch ? "I couldn't catch it" : i.answer || '(blank)'}</span>
            <span class="small muted">${pct(i.wordAccuracy)} of words · ${i.plays} listen${i.plays === 1 ? '' : 's'}</span>
          </div>
          ${i.correct
            ? html`<span class="badge green"><span class="ic" aria-hidden="true">✓</span>Correct</span>`
            : waiting.has(i.reviewItemId)
              ? html`<span class="badge"><span class="ic" aria-hidden="true">⏳</span>Review on a later day</span>`
              : i.reviewItemId && ['immediate_pending', 'immediate_in_progress'].includes(i.reviewStatus)
              ? html`<a class="btn btn-blue btn-sm" href="#/review/${i.reviewItemId}">Review</a>`
              : html`<span class="badge yellow"><span class="ic" aria-hidden="true">✎</span>Reviewed</span>`}
        </li>`)}
    </ol>
    <div class="row" style="margin-top:20px;justify-content:space-between">
      <a href="#/today">← Back to Today</a>
      <a class="btn btn-ghost" href="#/test/${state.test.id}/redo">↻ Redo this test</a>
    </div>`);
}

function showPracticeSummary(root, state) {
  const s = state.summary;
  const diff = (s.wordAccuracy - s.original.wordAccuracy) * 100;
  setHtml(root, html`
    <section class="hero">
      <div>
        <span class="eyebrow">${state.test.title} · Redo ${s.practiceNo}</span>
        <h1>${s.exactCount} of ${s.itemCount} correct</h1>
        <p>First try: ${s.original.exactCount} of ${s.itemCount} correct (${pct(s.original.wordAccuracy)} of words).
          This redo: ${pct(s.wordAccuracy)} of words${Math.round(diff) ? ` (${diff > 0 ? '+' : ''}${Math.round(diff)} points)` : ''}. Your first score does not change.</p>
      </div>
      <img src="${s.exactCount >= s.original.exactCount ? IMG.congrats : IMG.writing}" alt="">
    </section>
    <ol class="stack-sm" style="list-style:none">
      ${s.items.map((i) => html`
        <li class="card stack-sm">
          <div class="row" style="justify-content:space-between">
            <strong>Sentence ${i.position}</strong>
            <span class="row" style="gap:6px">
              <span class="badge">First try: ${i.originalCorrect ? '✓' : '✗'}</span>
              ${i.correct ? html`<span class="badge green">✓ Correct now</span>` : html`<span class="badge coral">✗ ${pct(i.wordAccuracy)}</span>`}
            </span>
          </div>
          ${i.ops ? diffView({ ops: i.ops }) : html`<p class="${i.answer ? '' : 'muted'}">${i.couldntCatch ? "I couldn't catch it" : i.answer || '(blank)'}</p>
            <p class="small muted">The transcript appears here after you finish this sentence's Guided Review.</p>`}
          ${!i.correct && i.reviewItemId && i.ops ? html`<a class="small" href="#/practice/${i.reviewItemId}">Practise this sentence →</a>` : ''}
        </li>`)}
    </ol>
    <div class="row" style="margin-top:20px;justify-content:space-between">
      <a href="#/today">← Back to Today</a>
      <a class="btn btn-ghost" href="#/test/${state.test.id}/redo">↻ Redo again</a>
    </div>`);
}
