import { ApiError, audioUrl, get, post, tabSession } from '../api.js';
import { guardAnswerBox, monitorSession, playPanel, returnOverlay, sessionTakenOver } from '../listening.js';
import { InterruptedError, StrictPlayer } from '../strict-player.js';
import { strictUi } from '../strict-policy.js';
import { confirmModal, emptyState, errorView, fmtDateTime, html, IMG, msToClock, pct, setHtml, toast } from '../ui.js';

const STAGES = [
  ['self_correction', 'Self-correction'],
  ['feedback', 'Feedback'],
  ['guided', 'Guided listening'],
  ['final_recall', 'Final recall'],
];

function stageBar(stage) {
  const idx = STAGES.findIndex(([s]) => s === stage);
  const at = stage === 'done' ? 4 : idx;
  return html`<ol class="stages" aria-label="Review steps">
    ${STAGES.map(([, label], i) => html`<li class="stage ${i < at ? 'done' : i === at ? 'active' : ''}" ${i === at ? 'aria-current="step"' : ''}>
      <span class="n" aria-hidden="true">${i < at ? '✓' : i + 1}</span>${label}</li>`)}
  </ol>`;
}

function answerBlock(kind, tag, text) {
  const icon = { independent: '🎧', assisted: '✎', transcript: '★' }[kind];
  return html`<div class="answer-block ${kind}"><div class="tag"><span aria-hidden="true">${icon}</span>${tag}</div>
    ${text ? html`<p>${text}</p>` : html`<p class="empty-answer">(blank)</p>`}</div>`;
}

/** Word-level comparison. Each difference has a text marker so color is never the only signal. */
export function diffView(result) {
  return html`<div class="diff">${result.ops.map((o) => {
    if (o.op === 'match') return html`<span class="w match">${o.ref}</span>`;
    if (o.op === 'sub') return html`<span class="w sub" title="You wrote “${o.hyp}”">${o.ref}<small>(you: ${o.hyp}${o.possibleSpelling ? ' · spelling?' : ''})</small></span>`;
    if (o.op === 'del') return html`<span class="w del" title="Missing">${o.ref}<small>(missing)</small></span>`;
    return html`<span class="w ins" title="Extra word">${o.hyp}<small>(extra)</small></span>`;
  })}</div>`;
}

function differenceLists(r) {
  const spelling = r.substituted.filter((s) => s.possibleSpelling);
  const other = r.substituted.filter((s) => !s.possibleSpelling);
  const li = (items) => (items.length ? html`<ul style="padding-left:18px">${items}</ul>` : html`<p class="muted small">None</p>`);
  return html`<div class="grid-2 small">
    <div><h3>Missing words</h3>${li(r.missing.map((w) => html`<li>${w}</li>`))}</div>
    <div><h3>Extra words</h3>${li(r.extra.map((w) => html`<li>${w}</li>`))}</div>
    <div><h3>Different words</h3>${li(other.map((s) => html`<li>heard “${s.heard}” → “${s.expected}”</li>`))}</div>
    <div><h3>Possible spelling errors</h3>${li(spelling.map((s) => html`<li>“${s.heard}” → “${s.expected}”</li>`))}</div>
  </div>`;
}

export async function reviewPage(root, [idStr]) {
  root.classList.add('narrow');
  const reviewItemId = Number(idStr);
  const scope = `review:${reviewItemId}`;
  let start;
  try {
    start = await post(`/api/cp/reviews/${reviewItemId}/start`, { resumeFrom: tabSession.get(scope) });
  } catch (err) {
    if (err.code === 'NOT_DUE') return setHtml(root, emptyState(IMG.sleepy, 'Not due yet', 'This review will appear in your queue when it is due.'));
    if (err.code === 'GUIDED_LIMIT_REACHED') return setHtml(root, emptyState(IMG.sleepy, "That's enough for today", err.message));
    if (err.code === 'NO_REVIEW_OPEN') return setHtml(root, emptyState(IMG.congrats, 'Nothing to do here', 'This sentence has no review open right now.'));
    return setHtml(root, errorView(err));
  }
  tabSession.set(scope, start.sessionId);
  const { reviewAttemptId: ra, sessionId } = start;
  const base = `/api/cp/review-attempts/${ra}`;

  let s = await get(base);
  let player = null;
  let playing = false;
  let busy = false;
  let stopped = false;
  let guidedAudio = null;
  let guidedUrl = null;

  const stopMonitor = monitorSession({
    sessionId,
    getPlayer: () => player,
    describe: () => s.attempt.stage,
    onReturn: async (hiddenMs) => {
      guidedAudio?.pause();
      if (s.attempt.kind === 'delayed' || playing) await returnOverlay(hiddenMs, { wasPlaying: playing });
      await refresh();
    },
  });

  function handleError(err) {
    if (err instanceof ApiError && (err.code === 'SESSION_SUPERSEDED' || err.code === 'SESSION_INVALID')) {
      stopped = true;
      stopMonitor();
      sessionTakenOver(() => reviewPage(root, [idStr]));
      return;
    }
    toast(err.message, 'error');
  }

  async function refresh() {
    try { s = await get(base); } catch (err) { return handleError(err); }
    render();
  }

  async function act(path, body, { confirm } = {}) {
    if (confirm && !(await confirmModal(confirm))) return;
    busy = true;
    render();
    try {
      const r = await post(`${base}/${path}`, { sessionId, ...body }, { idempotent: true });
      busy = false;
      if (s.attempt.kind === 'delayed' && path === 'delayed-submit') return delayedResult(r);
      await refresh();
    } catch (err) {
      busy = false;
      render();
      handleError(err);
    }
  }

  async function playStrict() {
    if (playing) return;
    player = new StrictPlayer({ authorizeUrl: `${base}/play`, sessionId });
    playing = true;
    s.plays = { ...s.plays, used: s.plays.used + 1, inFlight: true };
    render();
    try { await player.play(); } catch (err) { if (!(err instanceof InterruptedError)) handleError(err); }
    playing = false;
    player = null;
    if (!stopped) await refresh();
  }

  function header(title, sub) {
    return html`<div class="assess-top">
      <div><span class="eyebrow">${s.test.title}</span><h2>${title}</h2>${sub ? html`<p class="small muted">${sub}</p>` : ''}</div>
      <img src="${IMG.writing}" alt="" width="72" height="72">
    </div>`;
  }

  function answerBox(ui, { placeholder, value }) {
    return html`
      <label class="sr-only" for="ans">Your answer</label>
      <textarea id="ans" class="answer" ${ui.textareaEnabled ? '' : 'disabled'} placeholder="${placeholder}">${value}</textarea>
      <p class="hint" data-paste-note hidden>Copy and paste are turned off here.</p>`;
  }

  function wireAnswer() {
    const ta = root.querySelector('#ans');
    if (!ta) return;
    guardAnswerBox(ta, { sessionId, allowPaste: s.pasteException });
    let t;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => post(`${base}/draft`, { sessionId, text: ta.value }).catch(() => {}), 1200);
    });
  }

  function render() {
    if (stopped) return;
    const a = s.attempt;
    const prevText = root.querySelector('#ans')?.value;
    if (a.stage !== 'guided') teardownGuided();
    if (a.kind === 'delayed') return renderDelayed(prevText);
    switch (a.stage) {
      case 'self_correction': return renderSelf(prevText);
      case 'feedback': return renderFeedback();
      case 'guided': return renderGuided();
      case 'final_recall': return renderRecall(prevText);
      default: return renderDone();
    }
  }

  function renderSelf(prevText) {
    const ui = strictUi({ plays: s.plays, playing, submitting: busy });
    ui.textareaEnabled = !playing && !busy; // writing is allowed at any time in self-correction
    const label = s.attempt.kind === 'remediation' ? 'Your delayed review answer' : 'Your original answer (locked)';
    setHtml(root, html`<div class="lesson">
      ${header(s.attempt.kind === 'remediation' ? 'Remediation' : 'Immediate Review', 'Step A: listen again and correct your answer yourself. The transcript comes next.')}
      ${stageBar('self_correction')}
      ${answerBlock('independent', label, s.promptAnswer)}
      ${playPanel(ui, { statusText: ui.playing ? 'Listening…' : `${s.plays.allowed - s.plays.used} self-correction listen${s.plays.allowed - s.plays.used === 1 ? '' : 's'} left`, labelReplay: 'Listen' })}
      ${answerBox(ui, { placeholder: 'Write your corrected sentence…', value: prevText ?? (s.attempt.draft || s.promptAnswer || '') })}
      <div class="assess-actions"><span></span>
        <button class="btn btn-primary" data-go ${ui.playing || busy ? 'disabled' : ''}>Submit correction</button></div>
    </div>`);
    root.querySelector('[data-action="play"]').addEventListener('click', playStrict);
    wireAnswer();
    root.querySelector('[data-go]').addEventListener('click', () => act('self-correction', { text: root.querySelector('#ans').value }));
  }

  function renderFeedback() {
    setHtml(root, html`<div class="lesson stack">
      ${header('Feedback', 'Step B: compare your answers with the transcript.')}
      ${stageBar('feedback')}
      ${answerBlock('transcript', 'Correct transcript', s.transcript)}
      <div class="legend" aria-label="Legend">
        <span><span class="w sub">word<small>(you: …)</small></span> different word</span>
        <span><span class="w del">word<small>(missing)</small></span> missing</span>
        <span><span class="w ins">word<small>(extra)</small></span> extra</span>
      </div>
      <div class="answer-block independent"><div class="tag">🎧 ${s.attempt.kind === 'remediation' ? 'Delayed review answer' : 'Original answer'} · ${pct(s.original.wordAccuracy)}</div>${diffView(s.original)}</div>
      <div class="answer-block assisted"><div class="tag">✎ Your correction · ${pct(s.revised.wordAccuracy)}</div>${diffView(s.revised)}</div>
      <details><summary>Word-by-word list for your correction</summary>${differenceLists(s.revised)}</details>
      <p class="small muted">This compares written words only. It can't tell why a word was missed — that's something to explore in guided listening.</p>
      <div class="assess-actions"><span></span><button class="btn btn-primary" data-go ${busy ? 'disabled' : ''}>Continue to guided listening</button></div>
    </div>`);
    root.querySelector('[data-go]').addEventListener('click', () => act('advance', { from: 'feedback' }));
  }

  function teardownGuided() {
    if (guidedAudio) { guidedAudio.pause(); guidedAudio = null; }
    if (guidedUrl) { URL.revokeObjectURL(guidedUrl); guidedUrl = null; }
  }

  async function renderGuided() {
    const ui = strictUi({ plays: s.plays, playing, submitting: busy });
    setHtml(root, html`<div class="lesson stack">
      ${header('Guided listening', 'Step C: practice freely. Pause, slow down and repeat short phrases. This is not a test.')}
      ${stageBar('guided')}
      ${answerBlock('transcript', 'Transcript', s.transcript)}
      <div class="card flat guided">
        <div class="guided-controls">
          <button class="btn btn-blue btn-sm" data-g="toggle" ${playing ? 'disabled' : ''}>Play / Pause</button>
          <button class="btn btn-ghost btn-sm" data-g="back">⟲ 2s</button>
          <div class="speed-group" role="group" aria-label="Speed">
            ${[0.75, 0.9, 1].map((r) => html`<button data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`)}
          </div>
        </div>
        <label class="small" for="scrub">Position <span data-time class="mono">0:00.00</span></label>
        <input id="scrub" class="scrub" type="range" min="0" max="1000" value="0">
        <div class="guided-controls small">
          <button class="btn btn-ghost btn-sm" data-g="a">Mark phrase start</button>
          <button class="btn btn-ghost btn-sm" data-g="b">Mark phrase end</button>
          <button class="btn btn-ghost btn-sm" data-g="loop">Repeat phrase</button>
          <span data-phrase class="muted">No phrase marked</span>
        </div>
      </div>
      <div class="card flat">
        <h3>Full-sentence replays</h3>
        <p class="small muted">Hear the whole sentence at normal speed (${s.plays.allowed} available).</p>
        ${playPanel(ui, { statusText: ui.playing ? 'Playing the full sentence…' : '', labelPlay: 'Full replay', labelReplay: 'Full replay' })}
      </div>
      <div class="assess-actions"><span></span><button class="btn btn-primary" data-go ${playing || busy ? 'disabled' : ''}>I'm ready for final recall</button></div>
    </div>`);
    root.querySelector('[data-action="play"]').addEventListener('click', () => { guidedAudio?.pause(); playStrict(); });
    root.querySelector('[data-go]').addEventListener('click', () => act('advance', { from: 'guided' }, {
      confirm: { title: 'Hide the transcript?', body: 'In the last step you will hear the sentence once and write it without looking.', confirmLabel: 'Continue', img: IMG.listening },
    }));

    if (!guidedAudio) {
      try {
        guidedUrl = await audioUrl(`${base}/guided-audio`);
        guidedAudio = new Audio(guidedUrl);
        guidedAudio.preservesPitch = true;
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    }
    const audio = guidedAudio;
    const scrub = root.querySelector('#scrub');
    const timeEl = root.querySelector('[data-time]');
    let phrase = { a: null, b: null };
    let loopEnd = null;
    const sync = () => {
      if (!audio.duration) return;
      scrub.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
      timeEl.textContent = msToClock(audio.currentTime * 1000);
      if (loopEnd != null && audio.currentTime >= loopEnd) { audio.pause(); loopEnd = null; }
    };
    audio.ontimeupdate = sync;
    scrub.addEventListener('input', () => { if (audio.duration) audio.currentTime = (scrub.value / 1000) * audio.duration; sync(); });
    root.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', () => {
      audio.playbackRate = Number(b.dataset.rate);
      root.querySelectorAll('[data-rate]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const phraseLabel = () => {
      root.querySelector('[data-phrase]').textContent = phrase.a != null && phrase.b != null
        ? `Phrase ${msToClock(phrase.a * 1000)} → ${msToClock(phrase.b * 1000)}` : phrase.a != null ? `Start ${msToClock(phrase.a * 1000)}` : 'No phrase marked';
    };
    root.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.g;
      if (g === 'toggle') { loopEnd = null; audio.paused ? audio.play() : audio.pause(); }
      if (g === 'back') audio.currentTime = Math.max(0, audio.currentTime - 2);
      if (g === 'a') { phrase = { a: audio.currentTime, b: null }; phraseLabel(); }
      if (g === 'b' && phrase.a != null && audio.currentTime > phrase.a) { phrase.b = audio.currentTime; phraseLabel(); }
      if (g === 'loop' && phrase.a != null && phrase.b != null) { audio.currentTime = phrase.a; loopEnd = phrase.b; audio.play(); }
    }));
  }

  function renderRecall(prevText) {
    const ui = strictUi({ plays: s.plays, playing, submitting: busy });
    ui.textareaEnabled = s.canWrite && !playing && !busy;
    ui.submitEnabled = ui.textareaEnabled;
    setHtml(root, html`<div class="lesson">
      ${header('Final recall', 'Step D: listen once more, then write the sentence without looking.')}
      ${stageBar('final_recall')}
      ${playPanel(ui, { statusText: ui.playing ? 'Listening…' : s.plays.used ? 'Now write the whole sentence.' : 'One listen. Write after it ends.' })}
      ${answerBox(ui, { placeholder: 'Write the sentence from memory…', value: prevText ?? s.attempt.draft ?? '' })}
      <div class="assess-actions"><span class="small muted">It doesn't need to be perfect.</span>
        <button class="btn btn-primary" data-go ${ui.submitEnabled ? '' : 'disabled'}>Finish review</button></div>
    </div>`);
    root.querySelector('[data-action="play"]').addEventListener('click', playStrict);
    wireAnswer();
    root.querySelector('[data-go]').addEventListener('click', () => act('final-recall', { text: root.querySelector('#ans').value }));
  }

  function renderDelayed(prevText) {
    if (s.attempt.stage === 'done') return renderDone();
    const ui = strictUi({ plays: s.plays, playing, submitting: busy });
    setHtml(root, html`<div class="lesson">
      ${header('Delayed Review', `A sentence you missed earlier. Same rules as the test: two full listens, no transcript.`)}
      ${s.recovery ? html`<div class="banner coral" role="alert"><img src="${IMG.sorry}" alt=""><div><strong>The audio didn't play completely.</strong> This is recorded as a technical problem. Ask your teacher to restore a listen, or choose “I couldn't catch it”.</div></div>` : ''}
      ${playPanel(ui, { statusText: ui.playing ? 'Listening… the answer box opens when the sentence ends.' : s.plays.used === 0 ? 'Listen to the complete sentence and type what you hear.' : s.plays.used < s.plays.allowed ? 'Write what you heard. You may replay once more.' : 'No listens left. Check your answer, then submit.' })}
      ${answerBox(ui, { placeholder: ui.textareaEnabled ? 'Type the whole sentence…' : 'The answer box opens after the first full listen.', value: prevText ?? s.attempt.draft ?? '' })}
      <div class="assess-actions">
        <button class="link-btn" data-couldnt ${ui.couldntCatchEnabled ? '' : 'disabled'}>I couldn't catch it</button>
        <button class="btn btn-primary" data-go ${ui.submitEnabled ? '' : 'disabled'}>Submit</button>
      </div>
    </div>`);
    root.querySelector('[data-action="play"]').addEventListener('click', playStrict);
    wireAnswer();
    const confirm = { title: 'Submit this answer?', body: 'It will be locked.', confirmLabel: 'Submit', img: IMG.unsure };
    root.querySelector('[data-go]').addEventListener('click', () => act('delayed-submit', { text: root.querySelector('#ans').value }, { confirm }));
    root.querySelector('[data-couldnt]').addEventListener('click', () => act('delayed-submit', { couldntCatch: true }, { confirm: { ...confirm, title: "Submit without an answer?" } }));
  }

  /** Today's remaining reviews, in queue order (oldest overdue first), excluding this sentence. */
  async function remainingReviews() {
    try {
      const q = await get('/api/cp/queue');
      return [...q.overdue, ...q.dueToday].filter((r) => r.id !== reviewItemId && r.mandatory !== false);
    } catch {
      return [];
    }
  }

  async function fillNext(slot, { primary }) {
    const rest = await remainingReviews();
    const el = root.querySelector(slot);
    if (!el) return;
    setHtml(el, rest.length
      ? html`<a class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" href="#/review/${rest[0].id}" data-next>
          Continue → next sentence <span class="count-dot" style="margin-left:4px">${rest.length} left</span></a>`
      : html`${primary ? html`<p class="muted" style="width:100%">That was the last review for today. 🎉</p>` : ''}
          <a class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" href="#/today">Back to Today</a>`);
    if (primary) el.querySelector('a')?.focus();
  }

  function delayedResult(r) {
    stopped = true;
    stopMonitor();
    const passed = r.result === 'passed';
    setHtml(root, html`<div class="lesson stack" style="text-align:center">
      <img src="${passed ? IMG.congrats : IMG.worried}" alt="" width="150" height="150" style="margin:0 auto">
      <h1>${passed ? 'You remembered it!' : 'Not quite yet'}</h1>
      <p class="muted">${passed ? 'This sentence is now marked as passed.' : `You got ${pct(r.wordAccuracy)} of the words. Let's look at it together in a short remediation.`}</p>
      <div class="row" style="justify-content:center" data-next-slot>
        ${passed ? '' : html`<a class="btn btn-primary" href="#/review/${reviewItemId}" data-again>Start remediation</a>`}
      </div>
    </div>`);
    root.querySelector('[data-again]')?.addEventListener('click', (e) => { e.preventDefault(); reviewPage(root, [idStr]); });
    if (passed) fillNext('[data-next-slot]', { primary: true });
  }

  function renderDone() {
    stopped = true;
    stopMonitor();
    const due = s.delayedDueAt;
    setHtml(root, html`<div class="lesson stack" style="text-align:center">
      <img src="${IMG.congrats}" alt="" width="150" height="150" style="margin:0 auto">
      <h1>Review complete</h1>
      ${s.reviewItem.status === 'teacher_hold'
        ? html`<p class="muted">Your teacher will help you with this sentence before it comes back.</p>`
        : due ? html`<p class="muted">It will come back for a Delayed Review on <strong>${fmtDateTime(due)}</strong>.</p>` : ''}
      <div class="row" style="justify-content:center" data-next-slot><span class="muted small">Loading next sentence…</span></div>
    </div>`);
    fillNext('[data-next-slot]', { primary: true });
  }

  render();
  return () => {
    stopped = true;
    player?.interrupt('navigated_away');
    teardownGuided();
    stopMonitor();
  };
}
