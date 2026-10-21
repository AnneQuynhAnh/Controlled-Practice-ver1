import { get } from '../api.js';
import {
  barChart, emptyState, fmtDate, fmtDateTime, html, IMG, modeBadge, pct, setHtml, statusBadge,
} from '../ui.js';

function testAction(t) {
  const redo = html`<a class="btn btn-ghost btn-block" href="#/test/${t.id}/redo">↻ Redo test${t.practice?.retakes ? ` (done ${t.practice.retakes}×)` : ''}</a>`;
  switch (t.status) {
    case 'available': return html`<a class="btn btn-primary btn-block" href="#/test/${t.id}">Start test</a>`;
    case 'overdue': return html`<p class="small muted">Past the due time — sent to your teacher.</p>`;
    case 'in_progress': return html`<a class="btn btn-primary btn-block" href="#/test/${t.id}">Continue</a>`;
    case 'review_required': return html`<div class="stack-sm"><a class="btn btn-blue btn-block" href="#/test/${t.id}">Review mistakes</a>${redo}</div>`;
    case 'submitted':
    case 'completed': return html`<div class="stack-sm"><a class="btn btn-ghost btn-block" href="#/test/${t.id}">View results</a>${redo}</div>`;
    default: return '';
  }
}

export function testCard(t) {
  return html`
    <article class="card test-card ${t.status === 'locked' ? 'locked' : ''}">
      <div class="card-head">
        <span class="num">${t.kind === 'final' ? 'FINAL' : `TEST ${String(t.number).padStart(2, '0')}`}</span>
        ${statusBadge(t.status)}
      </div>
      <h3>${t.title}</h3>
      <div class="row" style="gap:6px">${modeBadge(t.mode)}${t.itemCount ? html`<span class="badge">${t.itemCount} sentences</span>` : ''}</div>
      <div class="meta">
        <span>Opens: ${fmtDate(t.releaseAt)}</span>
        <span>Due: ${t.dueAt ? fmtDateTime(t.dueAt) : '—'}</span>
        ${t.progress && t.status === 'in_progress' ? html`<span>Progress: ${t.progress.position}/${t.progress.total} submitted</span>` : ''}
      </div>
      <div class="actions">${testAction(t)}</div>
    </article>`;
}

const REVIEW_KIND = {
  immediate: 'Guided review',
  delayed: 'Delayed review',
  remediation: 'Remediation',
};

function deadlineText(ms) {
  if (ms == null) return 'No deadline';
  const left = ms - Date.now();
  const hours = Math.floor(left / 3600e3);
  const when = fmtDateTime(ms);
  if (left < 0) return `Was due ${when}`;
  if (hours < 1) return `Due ${when} · less than an hour left`;
  if (hours < 24) return `Due ${when} · ${hours}h left`;
  return `Due ${when}`;
}

function todoCard(t) {
  const isTest = t.type === 'test';
  const href = isTest ? `#/test/${t.id}` : `#/review/${t.id}`;
  const action = isTest ? (t.status === 'in_progress' ? 'Continue' : 'Start') : 'Start';
  return html`
    <li class="todo ${isTest ? 'todo-test' : 'todo-review'}">
      <a href="${href}" class="todo-link">
        <span class="todo-type">${isTest ? '🎧 TEST' : '✎ REVIEW'}</span>
        <span class="todo-body">
          <strong>${t.title}</strong>
          <span class="small muted">
            ${isTest
              ? html`${t.itemCount} sentences${t.status === 'in_progress' && t.progress ? ` · ${t.progress.position}/${t.progress.total} done` : ''}`
              : html`${REVIEW_KIND[t.kind] ?? 'Review'}${t.cycles ? ` · round ${t.cycles + 1}` : ''}`}
          </span>
          <span class="small todo-due">${deadlineText(t.deadline)}</span>
          ${t.supportNote ? html`<span class="small"><strong>Teacher note:</strong> ${t.supportNote}</span>` : ''}
        </span>
        <span class="btn ${isTest ? 'btn-primary' : 'btn-blue'} btn-sm todo-go">${action}</span>
      </a>
    </li>`;
}

export async function today(root) {
  const d = await get('/api/cp/today');
  const plan = d.planDay;
  const next = d.upcoming[0];
  setHtml(root, html`
    <section class="hero">
      <div>
        <span class="eyebrow">${fmtDate(Date.now())}</span>
        <h1>To do List</h1>
        <p>${d.todo.length ? 'Hurry up! Practice now!' : "You're all caught up. Nice work."}</p>
      </div>
      <img src="${d.todo.length ? IMG.hello : IMG.congrats}" alt="">
    </section>

    ${d.todo.length
      ? html`<ol class="todo-list" aria-label="To do, soonest deadline first">${d.todo.map(todoCard)}</ol>`
      : emptyState(plan && plan.type === 'rest' ? IMG.sleepy : IMG.congrats, plan && plan.type !== 'test' ? plan.label : 'Nothing to do right now', 'New tests and reviews will appear here when they open.')}

    <div class="stack-sm small muted" style="margin-top:16px">
      ${next ? html`<p>Next test: <strong>${next.title}</strong> opens ${fmtDateTime(next.releaseAt)}.</p>` : ''}
      ${d.waitingForLater ? html`<p>${d.waitingForLater} more missed sentence${d.waitingForLater > 1 ? 's' : ''} will open for review on the next days (up to ${d.guidedLimit} a day).</p>` : ''}
      ${d.sentToTeacher ? html`<p>${d.sentToTeacher} past-due item${d.sentToTeacher > 1 ? 's were' : ' was'} sent to your teacher.</p>` : ''}
    </div>`);
}

export async function tests(root) {
  const { tests: list } = await get('/api/cp/tests');
  setHtml(root, html`
    <div class="page-head">
      <div><span class="eyebrow">Controlled Practice</span><h1>Tests</h1>
      <p class="lede">One test a day. Each sentence plays in full, at most twice. Feedback comes after the whole test.</p></div>
    </div>
    ${list.length ? html`<div class="grid">${list.map(testCard)}</div>` : emptyState(IMG.sleepy, 'No tests yet', 'Your teacher has not scheduled any tests.')}`);
}

export async function progress(root) {
  const m = await get('/api/cp/progress');
  const stat = (v, l, s = '') => html`<div class="stat"><div class="v">${v}</div><div class="l">${l}</div>${s ? html`<div class="s">${s}</div>` : ''}</div>`;
  setHtml(root, html`
    <div class="page-head">
      <div><span class="eyebrow">Controlled Practice</span><h1>My Progress</h1>
      <p class="lede">Each kind of practice is scored separately. Help you got in a review never changes your independent score.</p></div>
      <img src="${IMG.progress}" alt="" width="110" height="110">
    </div>
    ${m.testsCompleted === 0 ? emptyState(IMG.progress, 'Nothing to show yet', 'Finish your first Daily Test to see your progress.') : ''}
    <div class="stack">
      <div class="category independent">
        <h3>🎧 Independent listening</h3><p class="note">Your original locked answers only.</p>
        <div class="stats">
          ${stat(m.testsCompleted, 'Tests completed')}
          ${stat(pct(m.independent.wordAccuracy), 'Word accuracy')}
          ${stat(pct(m.independent.exactSentenceRate), 'Sentences fully correct')}
          ${stat(m.independent.avgPlaysPerSentence ?? '—', 'Listens per sentence', 'Out of 2')}
          ${stat(m.independent.unanswered, 'Sentences left blank')}
        </div>
      </div>
      ${barChart(m.timeline.map((t) => ({ label: t.number, value: t.wordAccuracy, tip: `${t.title}: ${pct(t.wordAccuracy)} · ${t.exactCount}/${t.itemCount} exact` })),
        { caption: 'Independent word accuracy by test, over time' })}
      <div class="category transfer">
        <h3>🌱 Previously unseen audio</h3><p class="note">Sentences you had never heard or read before the test.</p>
        <div class="stats">
          ${stat(pct(m.familiarity.unseen.wordAccuracy), 'Unseen audio accuracy', `${m.familiarity.unseen.sentences} sentences`)}
          ${stat(pct(m.familiarity.familiar.wordAccuracy), 'Practised audio accuracy', `${m.familiarity.familiar.sentences} sentences`)}
          ${stat(pct(m.transfer.wordAccuracy), 'Transfer tests', `${m.transfer.sentences} sentences`)}
        </div>
      </div>
      <div class="category assisted">
        <h3>✎ Immediate Review (assisted)</h3><p class="note">Self-correction and guided recall after seeing feedback.</p>
        <div class="stats">
          ${stat(pct(m.immediateReview.completionRate), 'Review completion', `${m.immediateReview.completed} of ${m.immediateReview.opened}`)}
          ${stat(m.immediateReview.selfCorrectionGain == null ? '—' : `${m.immediateReview.selfCorrectionGain >= 0 ? '+' : ''}${Math.round(m.immediateReview.selfCorrectionGain * 100)} pts`, 'Self-correction improvement')}
          ${stat(pct(m.immediateReview.finalRecallAccuracy), 'Guided recall accuracy')}
        </div>
      </div>
      <div class="category">
        <h3>↻ Extra practice</h3><p class="note">Redo tests and free practice. Separate from every score above.</p>
        <div class="stats">
          ${stat(m.practice.retakes, 'Tests redone')}
          ${stat(pct(m.practice.retakeAccuracy), 'Redo accuracy')}
          ${stat(m.practice.sentenceChecks, 'Practice tries', m.practice.sentenceChecks ? `${pct(m.practice.sentenceChecksCorrect)} fully correct` : '')}
        </div>
      </div>
      <div class="category delayed">
        <h3>⟳ Delayed Review</h3><p class="note">Strict two-listen checks 48 hours later.</p>
        <div class="stats">
          ${stat(pct(m.delayedReview.passRate), 'Delayed review pass rate', `${m.delayedReview.passed} of ${m.delayedReview.attempts}`)}
          ${stat(pct(m.delayedReview.accuracy), 'Delayed review accuracy')}
          ${stat(m.delayedReview.avgCyclesToPass ?? '—', 'Cycles needed to pass')}
        </div>
      </div>
    </div>`);
}
