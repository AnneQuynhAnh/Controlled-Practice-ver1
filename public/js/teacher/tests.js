import { audioUrl, get, patch, post, put } from '../api.js';
import {
  confirmModal, emptyState, fmtDateTime, fromLocalInput, html, IMG, MODE_LABEL, modeBadge, secs, setHtml, SKILL_LABEL, toast, toLocalInput,
} from '../ui.js';

const TEST_STATUS = { draft: ['Draft', '✎', ''], published: ['Published', '●', 'green'], archived: ['Archived', '▪', ''] };
const testStatusBadge = (s) => { const [l, i, c] = TEST_STATUS[s]; return html`<span class="badge ${c}"><span class="ic" aria-hidden="true">${i}</span>${l}</span>`; };

export async function testList(root) {
  const [{ tests }, settings] = await Promise.all([get('/api/teacher/tests'), get('/api/teacher/settings')]);
  setHtml(root, html`
    <div class="page-head">
      <div><span class="eyebrow">Teacher</span><h1>Test Manager</h1>
      <p class="lede">Each test has ${settings.items_per_test} sentences, played one per screen in a frozen order per student.</p></div>
      <div class="row"><button class="btn btn-ghost" data-new="final">New final assessment</button><button class="btn btn-primary" data-new="daily">New daily test</button></div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Test</th><th>Mode</th><th>Status</th><th>Opens</th><th>Due</th><th class="num">Sentences</th><th class="num">Assigned</th><th class="num">Started</th><th></th></tr></thead>
      <tbody>${tests.map((t) => html`<tr>
        <td><strong>${t.title}</strong>${t.plan_day ? html`<div class="tiny muted">Plan day ${t.plan_day}</div>` : ''}</td>
        <td>${modeBadge(t.mode)}</td><td>${testStatusBadge(t.status)}${t.status === 'draft' && t.assigned_count ? html`<div class="tiny" style="margin-top:4px">⚠ assigned, not published</div>` : ''}</td>
        <td class="small">${fmtDateTime(t.release_at)}</td><td class="small">${fmtDateTime(t.due_at)}</td>
        <td class="num ${t.item_count === settings.items_per_test ? '' : 'muted'}">${t.item_count}/${settings.items_per_test}</td>
        <td class="num">${t.status === 'published' && !t.assigned_count ? html`<span class="badge coral" title="Published but not assigned">⚠ 0</span>` : t.assigned_count}</td><td class="num">${t.attempt_count}</td>
        <td><a class="btn btn-ghost btn-sm" href="#/t/tests/${t.id}">Edit</a></td></tr>`)}</tbody>
    </table></div>`);
  root.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', async () => {
    const t = await post('/api/teacher/tests', { kind: b.dataset.new });
    location.hash = `#/t/tests/${t.id}`;
  }));
}

export async function testEditor(root, [idStr]) {
  const id = Number(idStr);
  let [test, settings, { segments }] = await Promise.all([
    get(`/api/teacher/tests/${id}`), get('/api/teacher/settings'), get('/api/teacher/segments?verified=1'),
  ]);
  let items = test.items.map((i) => i.segment);
  let dirtyItems = false;
  let editingAnswer = null;
  let clipPlayer = null;
  let acceptShort = false; // asked once per visit, not for every short clip

  function render() {
    const locked = test.attempt_count > 0;
    const used = new Set(items.map((s) => s.segment_id));
    const available = segments.filter((s) => !used.has(s.segment_id));
    const sources = new Set(items.map((s) => s.audio_id)).size;
    const vocab = [...test.vocab, '', '', ''].slice(0, 3);
    setHtml(root, html`
      <p><a href="#/t/tests">← Test Manager</a></p>
      <div class="page-head">
        <div><span class="eyebrow">${test.kind === 'final' ? 'Final assessment' : `Daily Test ${String(test.number).padStart(2, '0')}`}</span><h1>${test.title}</h1>
          <div class="row" style="margin-top:6px">${testStatusBadge(test.status)}${modeBadge(test.mode)}${locked ? html`<span class="badge yellow">🔒 ${test.attempt_count} student${test.attempt_count > 1 ? 's' : ''} started — sentences frozen</span>` : ''}</div></div>
        <div class="row">
          ${test.status === 'published'
            ? html`${locked ? '' : html`<button class="btn btn-ghost" data-status="draft">Unpublish</button>`}<button class="btn btn-ghost" data-status="archived">Archive</button>`
            : test.status === 'draft'
              ? html`<button class="btn btn-ghost" data-status="archived">Archive</button><button class="btn btn-primary" data-status="published" ${test.problems.length ? 'disabled' : ''}>Publish</button>`
              : ''}
        </div>
      </div>

      ${test.status === 'draft' && test.assignments.length ? html`
        <div class="banner coral" role="alert"><img src="${IMG.worried}" alt="">
          <div><strong>Assigned to ${test.assignments.length} student${test.assignments.length > 1 ? 's' : ''}, but still a draft</strong>
            Students see this test as Locked until you press <strong>Publish</strong>${test.problems.length ? ' — first fix the items listed below.' : '.'}</div>
        </div>` : ''}
      ${test.problems.length ? html`<div class="banner coral"><img src="${IMG.unsure}" alt=""><div><strong>Before publishing</strong><ul style="padding-left:18px">${test.problems.map((p) => html`<li>${p}</li>`)}</ul></div></div>` : ''}
      ${test.status === 'published' && !test.assignments.length ? html`
        <div class="banner coral" role="alert"><img src="${IMG.worried}" alt="">
          <div><strong>Published, but no students can see it yet</strong>
            Students only see tests that are assigned to them.
            <div style="margin-top:8px"><button class="btn btn-blue btn-sm" data-assign-all>Assign to all students</button>
            <a class="btn btn-ghost btn-sm" href="#/t/assign">Choose students</a></div></div>
        </div>` : ''}
      ${test.warnings.length ? html`<div class="banner"><div><strong>Suggestion</strong>${test.warnings.map((w) => html`<div>${w}</div>`)}</div></div>` : ''}

      <div class="grid-2">
        <form class="card stack" data-form="details">
          <h2>Details</h2>
          <div class="field"><label for="title">Title</label><input class="input" id="title" name="title" value="${test.title}"></div>
          <div class="field"><label for="mode">Listening mode</label>
            <select class="input" id="mode" name="mode" ${locked ? 'disabled' : ''}>
              ${Object.entries(MODE_LABEL).map(([v, l]) => html`<option value="${v}" ${test.mode === v ? 'selected' : ''}>${l}</option>`)}
            </select>
            <span class="hint">Recovery: previously studied audio, topic only. Training: unfamiliar audio, situation + up to 3 background words. Transfer: unseen audio, situation only.</span></div>
          <div class="field"><label for="topic">General topic <span class="hint">(shown in Recovery)</span></label><input class="input" id="topic" name="topic" value="${test.topic}"></div>
          <div class="field"><label for="situation">Situation <span class="hint">(shown in Training and Transfer)</span></label><input class="input" id="situation" name="situation" value="${test.situation}"></div>
          ${test.mode === 'training' ? html`<div class="field"><span class="label">Background vocabulary (max 3, never words from the sentences)</span>
            <div class="form-grid">${vocab.map((v, i) => html`<input class="input" name="vocab" aria-label="Background word ${i + 1}" value="${v}">`)}</div></div>` : ''}
          <div class="form-grid">
            <div class="field"><label for="rel">Opens (Vietnam time)</label><input class="input" type="datetime-local" id="rel" name="release_at" value="${toLocalInput(test.release_at)}"></div>
            <div class="field"><label for="due">Due (Vietnam time)</label><input class="input" type="datetime-local" id="due" name="due_at" value="${toLocalInput(test.due_at)}"></div>
          </div>
          <label class="check"><input type="checkbox" name="shuffle" ${test.shuffle_items ? 'checked' : ''} ${locked ? 'disabled' : ''}> Shuffle sentence order for each student (fixed once they start)</label>
          <div><button class="btn btn-blue" type="submit">Save details</button></div>
        </form>

        <section class="card stack">
          <div class="card-head"><h2>Sentences <span class="count-dot">${items.length}/${settings.items_per_test}</span></h2>
            <span class="badge ${sources >= Math.min(settings.min_sources_per_test, items.length) ? 'green' : 'yellow'}">${sources} source${sources === 1 ? '' : 's'}</span></div>
          ${items.length ? html`<p class="small muted">Listen to each clip, check the answer matches exactly what is said, then verify it.
            ${items.filter((x) => x.verification_status === 'verified').length}/${items.length} verified.</p>
          <ol class="stack-sm" style="list-style:none">${items.map((s, i) => {
            const heard = /Speech recognition heard: (.*)/.exec(s.source_notes || '')?.[1];
            const differs = heard && heard.replace(/[^a-z0-9 ]/gi, '').toLowerCase() !== s.transcript.replace(/[^a-z0-9 ]/gi, '').toLowerCase();
            return html`
            <li class="review-item" style="padding:12px 14px;flex-direction:column;align-items:stretch;gap:8px">
              <div class="what" style="flex:1;min-width:0">
                <div class="row" style="gap:6px">
                  <strong>${i + 1}.</strong>
                  ${s.verification_status === 'verified' ? html`<span class="badge green">✓ Verified</span>` : html`<span class="badge yellow">✎ Not verified</span>`}
                  <span class="badge ${s.outside_recommended_duration ? 'coral' : ''}">${secs(s.duration_ms)}${s.duration_ms < 4000 ? ' · short' : ''}</span>
                </div>
                ${editingAnswer === s.segment_id
                  ? html`<form class="row" data-answer-form="${s.segment_id}" style="margin-top:6px"><input class="input" name="t" value="${s.transcript}" style="flex:1" aria-label="Answer key"><button class="btn btn-blue btn-sm">Save</button><button type="button" class="btn btn-ghost btn-sm" data-answer-cancel>Cancel</button></form>`
                  : html`<span style="font-size:16px">${s.transcript}</span>`}
                ${differs ? html`<span class="small" style="color:var(--text)">⚠ Speech recognition heard: “${heard}”</span>` : ''}
                <span class="tiny muted">${s.source_name || s.source_title} · ${s.familiarity_status === 'unseen' ? 'Unseen' : 'Practised'}${s.in_attempts ? ' · 🔒 used by students' : ''}</span>
              </div>
              <div class="row" style="gap:6px">
                <button class="btn btn-ghost btn-sm" data-play="${s.segment_id}" aria-label="Play sentence ${i + 1}">▶ Listen</button>
                ${s.in_attempts ? '' : html`<button class="btn btn-ghost btn-sm" data-answer-edit="${s.segment_id}">Edit answer</button>`}
                ${s.verification_status === 'verified' ? '' : html`<button class="btn btn-blue btn-sm" data-verify="${s.segment_id}">Verify</button>`}
                ${locked ? '' : html`
                <button class="btn btn-ghost btn-sm" data-move="${i}:-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-ghost btn-sm" data-move="${i}:1" aria-label="Move down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-ghost btn-sm" data-remove="${i}" aria-label="Remove">✕</button>`}
              </div>
            </li>`;
          })}</ol>` : emptyState(IMG.listening, 'No sentences yet', 'Add verified segments from the Audio Library.')}
          ${locked ? '' : html`
            <div class="field"><label for="add">Add a verified segment</label>
              <select class="input" id="add" ${items.length >= settings.items_per_test ? 'disabled' : ''}>
                <option value="">Choose…</option>
                ${available.map((s) => html`<option value="${s.segment_id}">${s.source_title} — ${s.transcript.slice(0, 70)} (${secs(s.duration_ms)})</option>`)}
              </select>
              ${!segments.length ? html`<span class="hint">No verified segments yet. <a href="#/t/audio">Open the Audio Library</a>.</span>` : ''}</div>
            <div><button class="btn btn-blue" data-save-items ${dirtyItems ? '' : 'disabled'}>Save sentences</button></div>`}
        </section>
      </div>

      <section class="section card">
        <h2>Assigned students</h2>
        ${test.assignments.length ? html`<ul style="padding-left:18px">${test.assignments.map((a) => html`<li>${a.display_name}${a.release_at || a.due_at ? html` <span class="small muted">(own dates: ${fmtDateTime(a.release_at)} → ${fmtDateTime(a.due_at)})</span>` : ''}</li>`)}</ul>`
          : html`<p class="muted small">Not assigned yet. Use <a href="#/t/assign">Assignments</a>.</p>`}
      </section>`);

    root.querySelector('[data-form="details"]').addEventListener('submit', saveDetails);
    root.querySelector('[data-assign-all]')?.addEventListener('click', async () => {
      try {
        const { students } = await get('/api/teacher/students');
        if (!students.length) return toast('There are no student accounts yet.', 'error');
        await post('/api/teacher/assignments', { testIds: [id], studentIds: students.map((x) => x.id) });
        toast(`Assigned to ${students.length} student${students.length > 1 ? 's' : ''}`);
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => setStatus(b.dataset.status)));
    root.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => {
      const [i, d] = b.dataset.move.split(':').map(Number);
      [items[i], items[i + d]] = [items[i + d], items[i]];
      dirtyItems = true;
      render();
    }));
    root.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
      items.splice(Number(b.dataset.remove), 1);
      dirtyItems = true;
      render();
    }));
    root.querySelector('#add')?.addEventListener('change', (e) => {
      const seg = segments.find((s) => s.segment_id === Number(e.target.value));
      if (seg) { items.push(seg); dirtyItems = true; render(); }
    });
    root.querySelector('[data-save-items]')?.addEventListener('click', saveItems);
    root.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', async () => {
      clipPlayer?.pause();
      try {
        clipPlayer = new Audio(await audioUrl(`/api/teacher/segments/${b.dataset.play}/clip`));
        await clipPlayer.play();
      } catch (err) { toast(err.message, 'error'); }
    }));
    root.querySelectorAll('[data-answer-edit]').forEach((b) => b.addEventListener('click', () => {
      editingAnswer = Number(b.dataset.answerEdit);
      render();
      root.querySelector('[data-answer-form] input')?.focus();
    }));
    root.querySelector('[data-answer-cancel]')?.addEventListener('click', () => { editingAnswer = null; render(); });
    root.querySelector('[data-answer-form]')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const segId = Number(e.target.dataset.answerForm);
      try {
        await patch(`/api/teacher/segments/${segId}`, { transcript: new FormData(e.target).get('t') });
        toast('Answer saved — listen again and verify.');
        editingAnswer = null;
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', () => verify(Number(b.dataset.verify))));
  }

  async function verify(segId) {
    const seg = items.find((x) => x.segment_id === segId);
    if (seg.outside_recommended_duration && !acceptShort) {
      acceptShort = await confirmModal({
        title: 'Allow clips outside 4–8 seconds?',
        body: `This sentence is ${secs(seg.duration_ms)}. The recommended length is 4–8 seconds. Allow short or long clips for the rest of this page?`,
        confirmLabel: 'Allow and verify',
      });
      if (!acceptShort) return;
    }
    try {
      await post(`/api/teacher/segments/${segId}/verify`, { overrideDuration: seg.outside_recommended_duration });
      await reload();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function reload() {
    [test, { segments }] = await Promise.all([get(`/api/teacher/tests/${id}`), get('/api/teacher/segments?verified=1')]);
    items = test.items.map((i) => i.segment);
    dirtyItems = false;
    render();
  }

  async function saveDetails(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      title: f.get('title'), topic: f.get('topic'), situation: f.get('situation'),
      release_at: fromLocalInput(f.get('release_at')), due_at: fromLocalInput(f.get('due_at')),
    };
    if (!test.attempt_count) { body.mode = f.get('mode'); body.shuffle_items = f.get('shuffle') === 'on'; }
    if (f.has('vocab')) body.vocab = f.getAll('vocab').map((v) => v.trim()).filter(Boolean);
    try { await patch(`/api/teacher/tests/${id}`, body); toast('Saved'); await reload(); } catch (err) { toast(err.message, 'error'); }
  }

  async function saveItems() {
    try { await put(`/api/teacher/tests/${id}/items`, { segmentIds: items.map((s) => s.segment_id) }); toast('Sentences saved'); await reload(); } catch (err) { toast(err.message, 'error'); }
  }

  async function setStatus(status) {
    const msg = { published: 'Publish this test? Assigned students will see it from its opening time.', draft: 'Unpublish this test?', archived: 'Archive this test? It will be hidden from students.' }[status];
    if (!(await confirmModal({ title: msg, confirmLabel: 'Yes' }))) return;
    try { await post(`/api/teacher/tests/${id}/status`, { status }); toast('Updated'); await reload(); } catch (err) { toast(err.message, 'error'); }
  }

  render();
  return () => clipPlayer?.pause();
}
