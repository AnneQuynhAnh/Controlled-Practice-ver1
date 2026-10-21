// Free practice of sentences already reviewed: unlimited listening with pause, rewind and slow speed.
// Results are kept separately and never change scores or the review schedule.
import { audioUrl, get, post } from '../api.js';
import { emptyState, fmtDateTime, html, IMG, msToClock, pct, setHtml, toast } from '../ui.js';
import { diffView } from './review.js';

export async function practiceList(root) {
  const { items } = await get('/api/cp/practice');
  const byTest = new Map();
  for (const it of items) {
    if (!byTest.has(it.testTitle)) byTest.set(it.testTitle, []);
    byTest.get(it.testTitle).push(it);
  }
  setHtml(root, html`
    <div class="page-head">
      <div><span class="eyebrow">Controlled Practice</span><h1>Practice</h1>
      <p class="lede">Sentences you missed and already reviewed. Listen as many times as you like, pause and slow down. This never changes your scores.</p></div>
      ${items.length ? html`<a class="btn btn-primary" href="#/practice/${items[0].id}">Practise all from the start</a>` : ''}
    </div>
    ${items.length ? [...byTest].map(([title, list]) => html`
      <section class="section">
        <h2 style="margin-bottom:10px">${title}</h2>
        <ul class="stack-sm" style="list-style:none">${list.map((it) => html`
          <li class="review-item">
            <div class="what"><strong>Sentence ${it.sentence}</strong>
              <span class="small muted">${it.checks ? `${it.checks} tr${it.checks > 1 ? 'ies' : 'y'}` : 'Not practised yet'}${it.lastCorrect === true ? ' · last try ✓ correct' : it.lastCorrect === false ? ' · last try ✗' : ''}</span></div>
            <a class="btn btn-blue btn-sm" href="#/practice/${it.id}">Practise</a>
          </li>`)}</ul>
      </section>`)
    : emptyState(IMG.writing, 'Nothing to practise yet', 'Sentences you missed appear here after you finish their Guided Review.')}`);
}

export async function practicePage(root, [idStr]) {
  root.classList.add('narrow');
  const id = Number(idStr);
  let st;
  try {
    st = await get(`/api/cp/practice/${id}`);
  } catch (err) {
    return setHtml(root, emptyState(IMG.unsure, 'Not available', err.message));
  }
  let audio = null;
  let url = null;
  let result = null;

  function render() {
    setHtml(root, html`
      <p><a href="#/practice">← All practice sentences</a></p>
      <div class="lesson stack">
        <div class="assess-top">
          <div><span class="eyebrow">Practice · ${st.position} of ${st.total}</span><h2>${st.item.testTitle} · Sentence ${st.item.sentence}</h2></div>
        </div>
        <div class="card flat guided">
          <div class="guided-controls">
            <button class="btn btn-blue" data-g="toggle">▶ Play / Pause</button>
            <button class="btn btn-ghost btn-sm" data-g="back">⟲ 2s</button>
            <button class="btn btn-ghost btn-sm" data-g="restart">⏮ Start</button>
            <div class="speed-group" role="group" aria-label="Speed">
              ${[0.75, 0.9, 1].map((r) => html`<button data-rate="${r}" aria-pressed="${r === (audio?.playbackRate ?? 1)}">${r}×</button>`)}
            </div>
          </div>
          <label class="small" for="scrub">Position <span data-time class="mono">0:00.00</span></label>
          <input id="scrub" class="scrub" type="range" min="0" max="1000" value="0">
        </div>
        ${result ? html`
          <div class="answer-block transcript"><div class="tag">★ Transcript</div><p>${result.transcript}</p></div>
          <div class="answer-block assisted"><div class="tag">${result.exact ? '✓ Correct!' : `✎ Your try · ${pct(result.wordAccuracy)}`}</div>${diffView(result)}</div>
          <div class="assess-actions">
            <button class="btn btn-ghost" data-again>Try again</button>
            ${st.nextId ? html`<a class="btn btn-primary" href="#/practice/${st.nextId}">Next sentence →</a>` : html`<a class="btn btn-primary" href="#/practice">Finish</a>`}
          </div>`
        : html`
          <label class="sr-only" for="ans">Your answer</label>
          <textarea id="ans" class="answer" placeholder="Write the sentence, then press Check…"></textarea>
          <p class="hint" data-paste-note hidden>Copy and paste are turned off here.</p>
          <div class="assess-actions">
            ${st.nextId ? html`<a class="link-btn" href="#/practice/${st.nextId}">Skip</a>` : html`<span></span>`}
            <button class="btn btn-primary" data-check>Check</button>
          </div>`}
        ${st.history.length ? html`<details><summary>Earlier tries (${st.history.length})</summary>
          <ul class="small stack-sm" style="padding-left:18px;margin-top:8px">${st.history.map((h) => html`<li>${h.exact_match ? '✓' : '✗'} “${h.answer_text || '(blank)'}” · ${pct(h.word_accuracy)} · ${fmtDateTime(h.created_at)}</li>`)}</ul></details>` : ''}
      </div>`);
    wire();
  }

  function wire() {
    const scrub = root.querySelector('#scrub');
    const timeEl = root.querySelector('[data-time]');
    const sync = () => {
      if (!audio?.duration) return;
      scrub.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
      timeEl.textContent = msToClock(audio.currentTime * 1000);
    };
    if (audio) audio.ontimeupdate = sync;
    sync();
    scrub.addEventListener('input', () => { if (audio?.duration) audio.currentTime = (scrub.value / 1000) * audio.duration; });
    root.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
      if (!audio) return;
      if (b.dataset.g === 'toggle') (audio.paused ? audio.play() : audio.pause());
      if (b.dataset.g === 'back') audio.currentTime = Math.max(0, audio.currentTime - 2);
      if (b.dataset.g === 'restart') { audio.currentTime = 0; audio.play(); }
    }));
    root.querySelectorAll('[data-rate]').forEach((b) => b.addEventListener('click', () => {
      if (audio) audio.playbackRate = Number(b.dataset.rate);
      root.querySelectorAll('[data-rate]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const ta = root.querySelector('#ans');
    if (ta && !st.pasteException) {
      const block = (e) => { e.preventDefault(); const n = root.querySelector('[data-paste-note]'); n.hidden = false; setTimeout(() => { n.hidden = true; }, 3000); };
      for (const ev of ['paste', 'drop', 'copy', 'cut', 'contextmenu']) ta.addEventListener(ev, block);
    }
    root.querySelector('[data-check]')?.addEventListener('click', async () => {
      try {
        result = await post(`/api/cp/practice/${id}/check`, { text: ta.value }, { idempotent: true });
        st = await get(`/api/cp/practice/${id}`);
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelector('[data-again]')?.addEventListener('click', () => { result = null; render(); root.querySelector('#ans')?.focus(); });
  }

  try {
    url = await audioUrl(`/api/cp/practice/${id}/audio`);
    audio = new Audio(url);
    audio.preservesPitch = true;
  } catch (err) {
    toast(err.message, 'error');
  }
  render();
  return () => { audio?.pause(); if (url) URL.revokeObjectURL(url); };
}
