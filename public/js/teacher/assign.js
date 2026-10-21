import { del, get, patch, post } from '../api.js';
import { confirmModal, fmtDate, fmtDateTime, fromLocalInput, html, IMG, modeBadge, setHtml, toast, toLocalInput } from '../ui.js';

const DAY_TYPE = { test: '', review: 'Review & catch-up', rest: 'Rest / overdue review', final: 'Final unseen-audio assessment' };

export async function assignments(root) {
  const [plan, settings, { students }, { tests: list }] = await Promise.all([
    get('/api/teacher/schedule'), get('/api/teacher/settings'), get('/api/teacher/students'), get('/api/teacher/tests'),
  ]);
  const tests = list.filter((t) => t.status !== 'archived');
  const details = await Promise.all(tests.map((t) => get(`/api/teacher/tests/${t.id}`)));
  const assigned = new Map(); // `${testId}:${studentId}` -> assignment
  details.forEach((d) => d.assignments.forEach((a) => assigned.set(`${d.id}:${a.student_id}`, a)));
  const testByNumber = (n) => tests.find((t) => t.kind === 'daily' && t.number === n);
  const finalTest = tests.find((t) => t.kind === 'final');

  setHtml(root, html`
    <div class="page-head"><div><span class="eyebrow">Teacher</span><h1>Assignments</h1>
      <p class="lede">Set the 14-day plan, choose who takes each test, and configure the practice rules.</p></div>
      <img src="${IMG.progress}" alt="" width="110" height="110"></div>

    <div class="grid-2">
      <form class="card stack" data-plan>
        <h2>14-day plan</h2>
        <p class="small muted">All dates use Vietnam time (Asia/Ho_Chi_Minh). Each test opens at 00:00 on its day and is due at 23:59. You can change single dates in the Test Manager afterwards.</p>
        <div class="row"><div class="field" style="flex:1"><label for="sd">Start date (Day 1)</label><input class="input" type="date" id="sd" name="startDate" value="${plan.startDate ?? ''}" required></div>
          <button class="btn btn-primary" type="submit" style="align-self:flex-end">${plan.startDate ? 'Re-apply plan' : 'Apply plan'}</button></div>
        <ol class="stack-sm" style="list-style:none">
          ${plan.days.map((d) => {
            const t = d.type === 'test' ? testByNumber(d.testNumber) : d.type === 'final' ? finalTest : null;
            return html`<li class="row small" style="gap:10px;flex-wrap:nowrap">
              <span class="count-dot">${d.day}</span>
              <span style="min-width:96px" class="muted">${d.date ? fmtDate(Date.parse(`${d.date}T12:00:00+07:00`)) : '—'}</span>
              <span>${t ? html`<a href="#/t/tests/${t.id}">${t.title}</a> ${modeBadge(t.mode)}` : DAY_TYPE[d.type]}${d.type === 'final' && !finalTest ? html` <span class="muted">(create a final test in the Test Manager)</span>` : ''}</span>
            </li>`;
          })}
        </ol>
      </form>

      <form class="card stack" data-settings>
        <h2>Settings</h2>
        <div class="field"><label for="ipt">Sentences per test</label><input class="input" id="ipt" type="number" min="1" max="30" name="items_per_test" value="${settings.items_per_test}">
          <span class="hint">Tests must have exactly this many verified sentences to be published. Default 10.</span></div>
        <div class="field"><label for="msp">Different recordings per test (target)</label><input class="input" id="msp" type="number" min="1" max="30" name="min_sources_per_test" value="${settings.min_sources_per_test}">
          <span class="hint">Advisory: aim for 8–10 different conversations per test.</span></div>
        <div class="field"><label for="gl">New Guided Reviews per student per day</label><input class="input" id="gl" type="number" min="1" max="20" name="daily_guided_review_limit" value="${settings.daily_guided_review_limit}">
          <span class="hint">Other missed sentences wait in the pending remediation queue. Default 5.</span></div>
        <div class="field"><label for="dc">Required delayed reviews per student per day</label><input class="input" id="dc" type="number" min="1" max="20" name="daily_delayed_review_cap" value="${settings.daily_delayed_review_cap}">
          <span class="hint">Extra due items are shown as optional and are never discarded. Default 5.</span></div>
        <div><button class="btn btn-blue" type="submit">Save settings</button></div>
      </form>
    </div>

    <section class="section">
      <div class="section-head"><h2>Who takes which test</h2>
        <div class="row"><button class="btn btn-ghost btn-sm" data-all>Assign every test to every student</button></div></div>
      ${students.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Test</th><th>Opens</th>${students.map((s) => html`<th>${s.display_name}</th>`)}</tr></thead>
        <tbody>${tests.map((t) => html`<tr>
          <td><a href="#/t/tests/${t.id}">${t.title}</a> ${t.status === 'draft' ? html`<span class="badge">Draft</span>` : ''}</td>
          <td class="small">${fmtDateTime(t.release_at)}</td>
          ${students.map((s) => {
            const a = assigned.get(`${t.id}:${s.id}`);
            return html`<td><label class="check"><input type="checkbox" data-cell="${t.id}:${s.id}" ${a ? 'checked' : ''} aria-label="Assign ${t.title} to ${s.display_name}">
              ${a ? html`<button type="button" class="link-btn small" data-dates="${a.id}">${a.release_at || a.due_at ? 'Own dates' : 'Dates'}</button>` : ''}</label></td>`;
          })}</tr>`)}
        </tbody></table></div>` : html`<p class="muted">No student accounts yet. Create them with <code>npm run create-user -- student …</code>.</p>`}
    </section>
    <div data-dates-panel></div>`);

  root.querySelector('[data-plan]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const startDate = new FormData(e.target).get('startDate');
    if (plan.startDate && !(await confirmModal({ title: 'Re-apply the plan?', body: 'Release and due dates of all planned tests will be recalculated from this start date.', confirmLabel: 'Apply' }))) return;
    try { await post('/api/teacher/schedule', { startDate }); toast('Plan applied'); assignments(root); } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelector('[data-settings]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)]));
    try { await patch('/api/teacher/settings', body); toast('Settings saved'); } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelector('[data-all]')?.addEventListener('click', async () => {
    try {
      const r = await post('/api/teacher/assignments', { testIds: tests.map((t) => t.id), studentIds: students.map((s) => s.id) });
      toast(`${r.created} assignment${r.created === 1 ? '' : 's'} created`);
      assignments(root);
    } catch (err) { toast(err.message, 'error'); }
  });
  root.querySelectorAll('[data-cell]').forEach((c) => c.addEventListener('change', async () => {
    const [testId, studentId] = c.dataset.cell.split(':').map(Number);
    try {
      if (c.checked) await post('/api/teacher/assignments', { testIds: [testId], studentIds: [studentId] });
      else await del(`/api/teacher/assignments/${assigned.get(c.dataset.cell).id}`);
      assignments(root);
    } catch (err) { c.checked = !c.checked; toast(err.message, 'error'); }
  }));
  root.querySelectorAll('[data-dates]').forEach((b) => b.addEventListener('click', () => {
    const a = [...assigned.values()].find((x) => x.id === Number(b.dataset.dates));
    const panel = root.querySelector('[data-dates-panel]');
    setHtml(panel, html`<form class="section card stack" data-own>
      <h2>Dates for one student</h2><p class="small muted">Leave empty to use the test's dates.</p>
      <div class="form-grid">
        <div class="field"><label for="or">Opens</label><input class="input" type="datetime-local" id="or" name="r" value="${toLocalInput(a.release_at)}"></div>
        <div class="field"><label for="od">Due</label><input class="input" type="datetime-local" id="od" name="d" value="${toLocalInput(a.due_at)}"></div>
      </div><div><button class="btn btn-blue" type="submit">Save dates</button></div></form>`);
    panel.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await patch(`/api/teacher/assignments/${a.id}`, { releaseAt: fromLocalInput(f.get('r')), dueAt: fromLocalInput(f.get('d')) }); toast('Saved'); assignments(root); } catch (err) { toast(err.message, 'error'); }
    });
    panel.scrollIntoView({ behavior: 'smooth' });
  }));
}
