import { get, patch, post } from '../api.js';
import { barChart, emptyState, fmtDateTime, hbar, html, IMG, modeBadge, pct, setHtml, statusBadge, toast } from '../ui.js';

const num = (n, warn) => html`<span class="mono ${warn && n ? '' : 'muted'}">${n ? html`${warn ? html`<span aria-hidden="true">⚠ </span>` : ''}${n}` : '0'}</span>`;

export async function dashboard(root) {
  const d = await get('/api/teacher/dashboard');
  setHtml(root, html`
    <section class="hero">
      <div>
        <span class="eyebrow">Teacher · ${d.today}${d.planDay ? ` · Plan day ${d.planDay.day} of 14` : ''}</span>
        <h1>Controlled Practice</h1>
        <p>${d.todaysTests.length ? html`Today: ${d.todaysTests.map((t) => t.title).join(', ')}` : d.planDay ? d.planDay.label || 'No test released today.' : 'No test released today. Set the plan start date in Assignments.'}
        · ${d.settings.items_per_test} sentences per test · up to ${d.settings.daily_guided_review_limit} guided reviews per student per day</p>
      </div>
      <img src="${IMG.online}" alt="">
    </section>

    <section class="section">
      <div class="section-head"><h2>Past due <span class="count-dot">${d.overdue.length}</span></h2>
        <span class="small muted">Removed from the student's to-do list. Reopen if you still want it done.</span></div>
      ${d.overdue.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Student</th><th>What</th><th>Was due</th><th></th></tr></thead>
        <tbody>${d.overdue.map((o) => html`<tr>
          <td><a href="#/t/students/${o.studentId}">${o.name}</a></td>
          <td><span class="badge ${o.type === 'test' ? 'yellow' : 'blue'}">${o.type === 'test' ? 'TEST' : 'REVIEW'}</span> ${o.title}</td>
          <td class="small">${fmtDateTime(o.deadline)}</td>
          <td>${o.type === 'test'
            ? html`<button class="btn btn-ghost btn-sm" data-reopen-test="${o.assignmentId}">Reopen until tonight</button>`
            : html`<button class="btn btn-ghost btn-sm" data-reopen-review="${o.reviewItemId}">Reopen for today</button>`}</td>
        </tr>`)}</tbody></table></div>` : html`<p class="muted small">Nothing past due.</p>`}
    </section>

    ${d.completionSummary.length ? html`
      <section class="section"><div class="section-head"><h2>Daily completion</h2></div>
        <div class="stats">${d.completionSummary.map((c) => html`
          <div class="stat"><div class="l">${c.title}</div><div class="v">${c.submitted}/${c.assigned}</div>
          <div class="s">submitted · ${c.inProgress} in progress · ${c.notStarted} not started</div></div>`)}</div>
      </section>` : ''}

    <section class="section">
      <div class="section-head"><h2>Students</h2><a class="small" href="#/t/analytics">Compare in Analytics →</a></div>
      ${d.students.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Student</th><th>Today's test</th><th class="num">Immediate reviews open</th><th class="num">Pending queue</th><th class="num">Delayed overdue</th><th class="num">Teacher attention</th><th class="num">Listens / sentence</th><th>Practised vs unseen</th><th class="num">Flagged attempts</th></tr></thead>
        <tbody>${d.students.map((s) => html`<tr>
          <td><a href="#/t/students/${s.studentId}">${s.name}</a></td>
          <td>${s.today.length ? s.today.map((t) => html`<div>${statusBadge(t.status === 'available' ? 'not_started' : t.status)}</div>`) : html`<span class="muted">—</span>`}</td>
          <td class="num">${num(s.incompleteImmediate, true)}</td>
          <td class="num">${num(s.pendingRemediation)}</td>
          <td class="num">${num(s.overdueDelayed, true)}</td>
          <td class="num">${num(s.teacherAttention, true)}</td>
          <td class="num">${s.avgPlaysPerSentence ?? '—'}</td>
          <td class="small">${pct(s.familiarAccuracy)} / ${pct(s.unseenAccuracy)}</td>
          <td class="num">${num(s.flaggedAttempts, true)}</td>
        </tr>`)}</tbody></table></div>` : emptyState(IMG.unsure, 'No students yet', 'Create student accounts with npm run create-user.')}
    </section>

    <div class="grid-2 section">
      <section class="card">
        <h2>Repeatedly missed sentences</h2>
        <p class="small muted">Missed by two or more students, or failed in delayed review twice or more.</p>
        ${d.repeatedlyMissed.length ? html`<ul class="stack-sm" style="list-style:none;margin-top:10px">${d.repeatedlyMissed.map((r) => html`
          <li><strong>${r.transcript}</strong><div class="small muted">${r.source_title} · missed by ${r.students_missed} · delayed failures ${r.delayed_failures}</div></li>`)}</ul>`
          : html`<p class="muted small" style="margin-top:10px">None yet.</p>`}
      </section>
      <section class="card">
        <h2>Practised audio vs unseen audio</h2>
        <p class="small muted">Students whose accuracy on unseen audio is 20+ points below practised audio.</p>
        ${d.transferGaps.length ? html`<ul class="stack-sm" style="list-style:none;margin-top:10px">${d.transferGaps.map((g) => html`
          <li><a href="#/t/students/${g.studentId}">${g.name}</a> — practised ${pct(g.familiar)}, unseen ${pct(g.unseen)}</li>`)}</ul>`
          : html`<p class="muted small" style="margin-top:10px">No large gaps.</p>`}
      </section>
    </div>

    <section class="section">
      <div class="section-head"><h2>Attempts with integrity flags</h2></div>
      <p class="small muted" style="margin-bottom:10px">Patterns worth a conversation — not evidence of cheating. Browser monitoring can't see what happens outside the page.</p>
      ${d.flaggedAttempts.length ? html`<div class="table-wrap"><table><thead><tr><th>Student</th><th>Test</th><th>Flags</th><th></th></tr></thead><tbody>
        ${d.flaggedAttempts.map((a) => html`<tr><td>${a.display_name}</td><td>${a.title}</td>
          <td>${a.flags.map((f) => html`<div class="small">⚑ ${f.label}</div>`)}</td>
          <td><a class="btn btn-ghost btn-sm" href="#/t/attempts/${a.id}">Inspect</a></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted small">No flags.</p>`}
    </section>`);

  // End of today in Vietnam time (UTC+7, no DST).
  const endOfToday = Date.parse(`${d.today}T23:59:59+07:00`);
  root.querySelectorAll('[data-reopen-test]').forEach((b) => b.addEventListener('click', async () => {
    try { await patch(`/api/teacher/assignments/${b.dataset.reopenTest}`, { dueAt: endOfToday }); toast('Reopened until 23:59 tonight'); dashboard(root); } catch (err) { toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-reopen-review]').forEach((b) => b.addEventListener('click', async () => {
    // Showing it again from now makes it due by the end of today; the original due time is kept.
    try { await post(`/api/teacher/review-items/${b.dataset.reopenReview}`, { action: 'postpone', postponeUntil: Date.now() + 1000 }); toast('Reopened for today'); dashboard(root); } catch (err) { toast(err.message, 'error'); }
  }));
}

export async function analytics(root) {
  const { students } = await get('/api/teacher/analytics');
  const rows = [
    ['Independent', [
      ['Tests completed', (m) => m.testsCompleted, 'n'],
      ['Word accuracy', (m) => m.independent.wordAccuracy],
      ['Sentences fully correct', (m) => m.independent.exactSentenceRate],
      ['Used the second listen', (m) => m.independent.secondPlayRate],
      ['Listens per sentence', (m) => m.independent.avgPlaysPerSentence, 'n'],
      ['Blank sentences', (m) => m.independent.unanswered, 'n'],
      ['Active minutes per test (approx.)', (m) => (m.independent.avgActiveMinutesPerTest == null ? null : Math.round(m.independent.avgActiveMinutesPerTest * 10) / 10), 'n'],
    ]],
    ['Practised vs unseen audio', [
      ['Practised audio accuracy', (m) => m.familiarity.familiar.wordAccuracy],
      ['Unseen audio accuracy', (m) => m.familiarity.unseen.wordAccuracy],
      ['Transfer test accuracy', (m) => m.transfer.wordAccuracy],
    ]],
    ['Immediate Review (assisted)', [
      ['Completion rate', (m) => m.immediateReview.completionRate],
      ['Final guided recall accuracy', (m) => m.immediateReview.finalRecallAccuracy],
    ]],
    ['Delayed Review', [
      ['Pass rate', (m) => m.delayedReview.passRate],
      ['Accuracy', (m) => m.delayedReview.accuracy],
      ['Cycles needed to pass', (m) => m.delayedReview.avgCyclesToPass, 'n'],
      ['Teacher attention items', (m) => m.delayedReview.teacherAttention, 'n'],
    ]],
  ];
  setHtml(root, html`
    <div class="page-head"><div><span class="eyebrow">Teacher</span><h1>Analytics</h1>
      <p class="lede">Each category is measured separately. Assisted review results never change independent scores.</p></div>
      <img src="${IMG.progress}" alt="" width="110" height="110"></div>
    ${students.length ? html`
      ${rows.map(([title, metrics]) => html`
        <section class="section"><h2 style="margin-bottom:10px">${title}</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Metric</th>${students.map((s) => html`<th>${s.name}</th>`)}</tr></thead>
            <tbody>${metrics.map(([label, f, kind]) => html`<tr><td>${label}</td>
              ${students.map((s) => { const v = f(s.metrics); return html`<td>${kind === 'n' ? html`<span class="mono">${v ?? '—'}</span>` : v == null ? html`<span class="muted">—</span>` : hbar(v)}</td>`; })}</tr>`)}
            </tbody></table></div>
        </section>`)}
      <section class="section"><h2 style="margin-bottom:10px">Independent accuracy over time</h2>
        <div class="grid-2">${students.map((s) => s.metrics.timeline.length
          ? barChart(s.metrics.timeline.map((t) => ({ label: t.number, value: t.wordAccuracy, tip: `${t.title}: ${pct(t.wordAccuracy)} (${t.exactCount}/${t.itemCount} exact) · ${fmtDateTime(t.submittedAt)}` })), { caption: `${s.name} — word accuracy by test` })
          : html`<div class="card"><strong>${s.name}</strong><p class="muted small">No submitted tests yet.</p></div>`)}</div>
      </section>` : emptyState(IMG.unsure, 'No students yet')}
    <p class="small muted" style="margin-top:16px">${modeBadge('transfer')} Transfer accuracy counts only sentences the student had never heard or read before the test.</p>`);
}
