import { get, post } from '../api.js';
import {
  confirmModal, emptyState, fmtDateTime, fmtTime, fromLocalInput, html, IMG, modeBadge, pct, setHtml, statusBadge, toast,
} from '../ui.js';

const EVENT_LABEL = {
  test_started: 'Started test', item_opened: 'Opened sentence', audio_play_started: 'Listen started', audio_play_completed: 'Listen finished',
  audio_play_interrupted: 'Listen interrupted', draft_saved: 'Draft saved', answer_submitted: 'Answer submitted', tab_hidden: 'Left the tab',
  tab_visible: 'Came back to the tab', session_resumed: 'Reloaded / resumed', test_submitted: 'Test submitted',
  immediate_review_started: 'Immediate review started', immediate_review_completed: 'Immediate review completed',
  self_correction_submitted: 'Self-correction submitted', delayed_review_started: 'Delayed review started',
  delayed_review_completed: 'Delayed review completed', remediation_started: 'Remediation started', remediation_completed: 'Remediation completed',
  paste_attempt: 'Paste attempt blocked', copy_attempt: 'Copy attempt blocked', concurrent_session_detected: 'Opened in another tab/device',
};
const eventKind = (t) => (t.startsWith('audio') ? 'k-audio' : ['tab_hidden', 'paste_attempt', 'copy_attempt', 'concurrent_session_detected', 'audio_play_interrupted'].includes(t) ? 'k-warn' : t.includes('submitted') || t.includes('completed') ? 'k-submit' : '');

export async function students(root) {
  const { students: list } = await get('/api/teacher/students');
  setHtml(root, html`
    <div class="page-head"><div><span class="eyebrow">Teacher</span><h1>Students</h1><p class="lede">Submissions, listening records and session events.</p></div></div>
    ${list.length ? html`<div class="grid">${list.map((s) => html`
      <a class="card" href="#/t/students/${s.id}" style="text-decoration:none;color:inherit">
        <h3>${s.display_name}</h3><p class="small muted">@${s.username}</p>
        ${s.cp_paste_exception ? html`<span class="badge pink">Paste allowed (accessibility)</span>` : ''}
      </a>`)}</div>` : emptyState(IMG.unsure, 'No students yet')}`);
}

export async function studentDetail(root, [idStr]) {
  const id = Number(idStr);
  const d = await get(`/api/teacher/students/${id}`);
  const m = d.metrics;
  setHtml(root, html`
    <p><a href="#/t/students">← Students</a></p>
    <div class="page-head"><div><span class="eyebrow">Student</span><h1>${d.student.display_name}</h1></div>
      <label class="check"><input type="checkbox" data-paste ${d.student.cp_paste_exception ? 'checked' : ''}> Allow paste (accessibility exception)</label></div>
    <div class="grid-2">
      <div class="category independent"><h3>🎧 Independent</h3><p class="note">Original locked answers only.</p>
        <div class="stats"><div class="stat"><div class="v">${m.testsCompleted}</div><div class="l">Tests</div></div>
          <div class="stat"><div class="v">${pct(m.independent.wordAccuracy)}</div><div class="l">Word accuracy</div></div>
          <div class="stat"><div class="v">${m.independent.avgPlaysPerSentence ?? '—'}</div><div class="l">Listens / sentence</div></div>
          <div class="stat"><div class="v">${pct(m.familiarity.unseen.wordAccuracy)}</div><div class="l">Unseen audio</div></div></div></div>
      <div class="category assisted"><h3>✎ Assisted &amp; delayed</h3><p class="note">Reviews after feedback; never merged with the above.</p>
        <div class="stats"><div class="stat"><div class="v">${pct(m.immediateReview.completionRate)}</div><div class="l">Immediate reviews done</div></div>
          <div class="stat"><div class="v">${pct(m.immediateReview.finalRecallAccuracy)}</div><div class="l">Guided recall</div></div>
          <div class="stat"><div class="v">${pct(m.delayedReview.passRate)}</div><div class="l">Delayed pass rate</div></div>
          <div class="stat"><div class="v">${m.delayedReview.teacherAttention}</div><div class="l">Teacher attention</div></div></div></div>
    </div>
    <section class="section"><h2 style="margin-bottom:10px">Attempts</h2>
      ${d.attempts.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Test</th><th>Started</th><th>Submitted</th><th class="num">Active (approx.)</th><th>Flags</th><th></th></tr></thead>
        <tbody>${d.attempts.map((a) => html`<tr><td>${a.title} ${modeBadge(a.mode)}${a.attempt_kind === 'practice' ? html` <span class="badge">↻ Redo ${a.attempt_no - 1}</span>` : ''}</td><td class="small">${fmtDateTime(a.started_at)}${a.started_after_due ? html` <span class="badge coral">late</span>` : ''}</td>
          <td class="small">${a.submitted_at ? fmtDateTime(a.submitted_at) : html`<span class="badge yellow">In progress ${a.current_position}/${a.item_count}</span>`}</td>
          <td class="num">${Math.round(a.active_ms / 60000)} min</td>
          <td>${a.flags.length ? a.flags.map((f) => html`<div class="small">⚑ ${f.label}</div>`) : html`<span class="muted small">None</span>`}</td>
          <td><a class="btn btn-ghost btn-sm" href="#/t/attempts/${a.id}">Inspect</a></td></tr>`)}</tbody></table></div>`
        : html`<p class="muted small">No attempts yet.</p>`}
    </section>
    <section class="section"><h2 style="margin-bottom:10px">Tests</h2>
      <div class="table-wrap"><table><thead><tr><th>Test</th><th>Status</th></tr></thead>
      <tbody>${d.tests.map((t) => html`<tr><td>${t.title}</td><td>${statusBadge(t.status)}</td></tr>`)}</tbody></table></div>
    </section>`);
  root.querySelector('[data-paste]').addEventListener('change', async (e) => {
    try { await post(`/api/teacher/students/${id}/paste-exception`, { allowed: e.target.checked, reason: 'accessibility' }); toast('Updated'); } catch (err) { toast(err.message, 'error'); }
  });
}

function playbackList(rows) {
  if (!rows.length) return html`<span class="muted small">No listens</span>`;
  return html`<ol class="small" style="padding-left:18px">${rows.map((p) => html`<li>${p.context.replace('_', ' ')} · ${fmtTime(p.authorized_at)} · ${p.status === 'completed' ? '✓ finished' : p.status === 'interrupted' ? `⚠ interrupted (${p.end_reason})` : p.status}</li>`)}</ol>`;
}
const answer = (tag, text, cls, extra = '') => html`<div class="answer-block ${cls}"><div class="tag">${tag}${extra ? html` · ${extra}` : ''}</div>${text ? html`<p>${text}</p>` : html`<p class="empty-answer">(blank)</p>`}</div>`;

export async function attemptDetail(root, [idStr]) {
  const d = await get(`/api/teacher/attempts/${Number(idStr)}`);
  const a = d.attempt;
  setHtml(root, html`
    <p><a href="#/t/students/${a.student_id}">← ${a.display_name}</a></p>
    <div class="page-head"><div><span class="eyebrow">${a.display_name}</span><h1>${a.title}</h1>
      <div class="row">${modeBadge(a.mode)}<span class="small muted">Started ${fmtDateTime(a.started_at)} · ${a.submitted_at ? `Submitted ${fmtDateTime(a.submitted_at)}` : 'In progress'} · active ≈ ${Math.round(a.active_ms / 60000)} min</span></div></div></div>
    ${d.flags.length ? html`<div class="banner"><img src="${IMG.unsure}" alt=""><div><strong>Patterns to look at</strong>${d.flags.map((f) => html`<div>⚑ ${f.label}</div>`)}
      <div class="small muted">These are prompts for a conversation, not conclusions.</div></div></div>` : ''}
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        ${d.items.map((it) => html`<section class="card stack-sm">
          <div class="card-head"><h3>Sentence ${it.position}</h3>
            ${it.answer_submitted_at ? (it.exact_match ? html`<span class="badge green">✓ Correct</span>` : html`<span class="badge coral">✗ ${pct(it.word_accuracy)}</span>`) : html`<span class="badge yellow">Not submitted</span>`}</div>
          ${answer('★ Transcript', it.transcript, 'transcript')}
          <h4 class="eyebrow" style="margin-top:8px">Independent</h4>
          ${it.answer_submitted_at ? answer('🎧 Original submission', it.couldnt_catch ? "I couldn't catch it" : it.answer_text, 'independent', fmtDateTime(it.answer_submitted_at)) : ''}
          <div class="small">Listens ${it.playback_start_count}/${2 + it.credits_restored} · finished ${it.playback_completed_count} · interrupted ${it.playback_interruption_count} · ${it.familiarity_at_start === 'unseen' ? 'unseen audio' : 'practised audio'}</div>
          ${playbackList(it.playback)}
          ${!it.answer_submitted_at && it.playback_interruption_count && a.status === 'in_progress' ? html`<button class="btn btn-ghost btn-sm" data-restore="item_attempt:${it.id}">Restore one listen</button>` : ''}
          ${it.review ? html`<h4 class="eyebrow" style="margin-top:8px">Assisted &amp; delayed</h4>
            <div class="small">Status: ${it.review.status.replaceAll('_', ' ')}${it.review.teacher_attention ? ' · ✋ teacher attention' : ''}${it.review.delayed_due_at ? ` · delayed due ${fmtDateTime(it.review.delayed_due_at)}` : ''}</div>
            ${it.review.attempts.map((ra) => html`<details><summary>${ra.kind} review${ra.kind !== 'immediate' ? ` (cycle ${ra.cycle})` : ''} — ${ra.completed_at ? fmtDateTime(ra.completed_at) : 'open'}</summary><div class="stack-sm" style="margin-top:8px">
              ${ra.self_correction_text != null ? answer('✎ Self-correction', ra.self_correction_text, 'assisted', pct(ra.self_correction_accuracy)) : ''}
              ${ra.final_recall_text != null ? answer('✎ Guided recall', ra.final_recall_text, 'assisted', pct(ra.final_recall_accuracy)) : ''}
              ${ra.delayed_answer_text != null ? answer('⟳ Delayed review', ra.delayed_couldnt_catch ? "I couldn't catch it" : ra.delayed_answer_text, 'independent', `${ra.delayed_result} · ${pct(ra.delayed_accuracy)}`) : ''}
              ${playbackList(ra.playback)}
              ${ra.kind === 'delayed' && !ra.completed_at ? html`<button class="btn btn-ghost btn-sm" data-restore="review_attempt:${ra.id}">Restore one listen</button>` : ''}
            </div></details>`)}` : ''}
        </section>`)}
      </div>
      <section class="card"><h2 style="margin-bottom:10px">Timeline</h2>
        <ol class="timeline">${d.timeline.map((e) => html`<li class="${eventKind(e.event_type)}"><time>${fmtTime(e.server_ts)}</time>${EVENT_LABEL[e.event_type] ?? e.event_type}
          ${e.metadata.position ? html` <span class="muted">· sentence ${e.metadata.position}</span>` : ''}${e.metadata.reason ? html` <span class="muted">· ${e.metadata.reason}</span>` : ''}${e.metadata.hiddenMs ? html` <span class="muted">· away ${Math.round(e.metadata.hiddenMs / 1000)}s</span>` : ''}</li>`)}</ol>
        ${d.restorations.length ? html`<h3 style="margin-top:14px">Restored listens</h3>${d.restorations.map((r) => html`<p class="small">${fmtDateTime(r.created_at)} — ${r.reason}</p>`)}` : ''}
      </section>
    </div>`);
  root.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restore(b.dataset.restore, () => attemptDetail(root, [idStr]))));
}

async function restore(target, done) {
  const [ownerType, ownerId] = target.split(':');
  const reason = prompt('Why are you restoring a listen? (recorded)');
  if (!reason?.trim()) return;
  try { await post('/api/teacher/restore-credit', { ownerType, ownerId: Number(ownerId), reason }); toast('Listen restored'); done(); } catch (err) { toast(err.message, 'error'); }
}

export async function reviewManagement(root) {
  const [{ items }, recovery] = await Promise.all([get('/api/teacher/reviews'), get('/api/teacher/recovery')]);
  setHtml(root, html`
    <div class="page-head"><div><span class="eyebrow">Teacher</span><h1>Review Management</h1>
      <p class="lede">Sentences that failed delayed review, and listens interrupted by technical problems.</p></div>
      <img src="${IMG.writing}" alt="" width="110" height="110"></div>
    <section class="section"><h2 style="margin-bottom:10px">Needs attention</h2>
      ${items.length ? html`<div class="stack">${items.map((r) => html`
        <article class="card ${r.teacher_attention ? 'priority' : 'priority-blue'} stack-sm">
          <div class="card-head"><div><strong>${r.display_name}</strong> · ${r.test_title} · sentence ${r.position}
            <div class="small muted">Status: ${r.status.replaceAll('_', ' ')} · consecutive failures ${r.consecutive_failures} · delayed reviews ${r.delayed_cycles}${r.delayed_due_at ? ` · due ${fmtDateTime(r.delayed_due_at)}` : ''}${r.postponed_until ? ` · shown from ${fmtDateTime(r.postponed_until)}` : ''}</div></div>
            ${r.teacher_attention ? html`<span class="badge coral">✋ Teacher attention</span>` : ''}</div>
          ${answer('★ Transcript', r.transcript, 'transcript')}
          ${r.attempts.filter((x) => x.kind === 'delayed' && x.completed_at).map((x) => html`<div class="small">Delayed ${x.cycle}: “${x.delayed_answer_text || '(blank)'}” · ${pct(x.delayed_accuracy)}</div>`)}
          <form class="row" data-note="${r.id}"><input class="input" style="flex:1" name="note" placeholder="Support note / easier word or phrase exercise for the student" value="${r.support_note}"><button class="btn btn-ghost btn-sm">Save note</button></form>
          <div class="row">
            <button class="btn btn-blue btn-sm" data-act="resolve:${r.id}">Resolve &amp; schedule delayed review in 48h</button>
            <button class="btn btn-ghost btn-sm" data-act="postpone:${r.id}">Postpone</button>
            <button class="btn btn-ghost btn-sm" data-act="close:${r.id}">Close item</button>
          </div>
        </article>`)}</div>` : emptyState(IMG.congrats, 'Nothing needs attention', 'Items that fail delayed review appear here.')}
    </section>
    <section class="section"><h2 style="margin-bottom:10px">Interrupted listens (technical recovery)</h2>
      ${recovery.items.length || recovery.reviews.length ? html`<div class="table-wrap"><table><thead><tr><th>Student</th><th>Where</th><th class="num">Listens</th><th></th></tr></thead><tbody>
        ${recovery.items.map((i) => html`<tr><td>${i.display_name}</td><td>${i.title} · sentence ${i.position}</td>
          <td class="num">${i.playback_start_count}/${2 + i.credits_restored} · ${i.playback_interruption_count} interrupted</td>
          <td><button class="btn btn-ghost btn-sm" data-restore="item_attempt:${i.id}">Restore one listen</button></td></tr>`)}
        ${recovery.reviews.map((i) => html`<tr><td>${i.display_name}</td><td>${i.title} · sentence ${i.position} (delayed review)</td>
          <td class="num">${i.starts}/${2 + i.credits_restored} · ${i.interruptions} interrupted</td>
          <td><button class="btn btn-ghost btn-sm" data-restore="review_attempt:${i.id}">Restore one listen</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted small">No interrupted listens.</p>`}
    </section>`);
  const reload = () => reviewManagement(root);
  root.querySelectorAll('[data-note]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post(`/api/teacher/review-items/${f.dataset.note}`, { action: 'support_note', note: new FormData(f).get('note') }); toast('Note saved'); } catch (err) { toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const [action, id] = b.dataset.act.split(':');
    const body = { action };
    if (action === 'postpone') {
      const v = prompt('Show this review from (YYYY-MM-DD HH:MM, Vietnam time):');
      if (!v) return;
      body.postponeUntil = fromLocalInput(v.trim().replace(' ', 'T'));
    }
    if (action === 'close' && !(await confirmModal({ title: 'Close this item?', body: 'It will leave the review cycle.', confirmLabel: 'Close' }))) return;
    try { await post(`/api/teacher/review-items/${id}`, body); toast('Updated'); reload(); } catch (err) { toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restore(b.dataset.restore, reload)));
}

