import { api, audioUrl, get, patch, post } from '../api.js';
import {
  confirmModal, emptyState, fmtDateTime, html, IMG, msToClock, secs, setHtml, SKILL_LABEL, toast,
} from '../ui.js';

const DIFF = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export async function audioLibrary(root) {
  const { audio } = await get('/api/teacher/audio');
  setHtml(root, html`
    <div class="page-head">
      <div><span class="eyebrow">Teacher</span><h1>Audio Library</h1>
      <p class="lede">Upload recordings, add transcripts, and cut them into sentence segments for tests.</p></div>
      <img src="${IMG.listening}" alt="" width="110" height="110">
    </div>
    <form class="card stack" data-upload>
      <h2>Upload a recording</h2>
      <div class="form-grid">
        <div class="field"><label for="f">Audio file</label><input class="input" id="f" type="file" name="file" accept="audio/*" required></div>
        <div class="field"><label for="t">Title</label><input class="input" id="t" name="title" required></div>
        <div class="field"><label for="s">Source</label><input class="input" id="s" name="source" placeholder="Book, unit, track…"></div>
      </div>
      <div class="field"><label for="r">Rights note</label><input class="input" id="r" name="rights" placeholder="e.g. School licence for classroom use"></div>
      <label class="check"><input type="checkbox" name="permission" required> I have permission to use this recording with my students. Owning a copy does not by itself give permission to share it.</label>
      <p class="hint">Source names are never shown to students during assessments.</p>
      <div class="row"><button class="btn btn-primary" type="submit">Upload</button><span class="small muted" data-progress></span></div>
    </form>
    <section class="section">
      <h2 style="margin-bottom:10px">Recordings</h2>
      ${audio.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Title</th><th>Source</th><th class="num">Length</th><th class="num">Segments</th><th class="num">Verified</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${audio.map((a) => html`<tr ${a.archived_at ? 'class="muted"' : ''}>
          <td><strong>${a.title}</strong>${a.archived_at ? html` <span class="badge">Archived</span>` : ''}</td><td>${a.source}</td>
          <td class="num">${msToClock(a.duration_ms)}</td><td class="num">${a.segment_count}</td><td class="num">${a.verified_count}</td>
          <td class="small">${fmtDateTime(a.created_at)}</td><td><a class="btn btn-ghost btn-sm" href="#/t/audio/${a.id}">Open</a></td></tr>`)}
        </tbody></table></div>` : emptyState(IMG.listening, 'No recordings yet', 'Upload your first recording above.')}
    </section>`);

  root.querySelector('[data-upload]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const file = f.get('file');
    if (!file?.size) return toast('Choose an audio file.', 'error');
    const q = new URLSearchParams({ title: f.get('title'), source: f.get('source'), rightsNote: f.get('rights'), permission: f.get('permission') ? '1' : '0' });
    root.querySelector('[data-progress]').textContent = 'Uploading and checking the audio…';
    try {
      const a = await api('POST', `/api/teacher/audio?${q}`, file, { raw: true, headers: { 'Content-Type': file.type || 'audio/mpeg' } });
      location.hash = `#/t/audio/${a.id}`;
    } catch (err) {
      root.querySelector('[data-progress]').textContent = '';
      toast(err.message, 'error');
    }
  });
}

export async function audioDetail(root, [idStr]) {
  const id = Number(idStr);
  let audio = await get(`/api/teacher/audio/${id}`);
  const { students } = await get('/api/teacher/students');
  let editing = null; // segment being edited, or null for a new one
  let draft = null; // unsaved form values kept across re-renders
  let sel = { start: 0, end: Math.min(6000, audio.duration_ms) };
  const player = new Audio();
  player.preload = 'auto';
  audioUrl(`/api/teacher/audio/${id}/file`).then((u) => { player.src = u; }).catch((err) => toast(err.message, 'error'));
  let stopAt = null;
  player.addEventListener('timeupdate', () => {
    const el = root.querySelector('[data-now]');
    if (el) el.textContent = msToClock(player.currentTime * 1000);
    if (stopAt != null && player.currentTime * 1000 >= stopAt) { player.pause(); stopAt = null; }
  });
  player.addEventListener('error', () => toast('This recording could not be played in the browser.', 'error'));

  function segForm() {
    const s = draft ?? editing ?? { transcript: '', topic: '', difficulty: 'medium', main_skill_tag: 'word_recognition', secondary_skill_tags: [], familiarity_status: 'unseen' };
    const dur = sel.end - sel.start;
    return html`
      <form class="card stack" data-seg>
        <div class="card-head"><h2>${editing ? `Edit segment #${editing.segment_id}` : 'New segment'}</h2>
          ${editing ? html`<button type="button" class="btn btn-ghost btn-sm" data-cancel>New segment instead</button>` : ''}</div>
        <div class="waveless-track" aria-hidden="true">
          ${audio.segments.map((x) => html`<div class="seg" style="left:${(x.start_ms / audio.duration_ms) * 100}%;width:${((x.end_ms - x.start_ms) / audio.duration_ms) * 100}%"></div>`)}
          <div class="sel" style="left:${(sel.start / audio.duration_ms) * 100}%;width:${(dur / audio.duration_ms) * 100}%"></div>
        </div>
        <div class="row small"><span>Playhead <strong class="mono" data-now>0:00.00</strong></span>
          <button type="button" class="btn btn-ghost btn-sm" data-p="play">Play / Pause source</button>
          <button type="button" class="btn btn-ghost btn-sm" data-p="back">⟲ 1s</button>
          <button type="button" class="btn btn-ghost btn-sm" data-p="fwd">1s ⟳</button>
          <button type="button" class="btn btn-ghost btn-sm" data-p="setStart">Set start here</button>
          <button type="button" class="btn btn-ghost btn-sm" data-p="setEnd">Set end here</button>
          <button type="button" class="btn btn-blue btn-sm" data-p="preview">Preview selection</button></div>
        <div class="form-grid">
          <div class="field"><label for="st">Start (ms)</label><input class="input mono" id="st" name="start_ms" type="number" min="0" max="${audio.duration_ms}" step="10" value="${sel.start}"></div>
          <div class="field"><label for="en">End (ms)</label><input class="input mono" id="en" name="end_ms" type="number" min="0" max="${audio.duration_ms}" step="10" value="${sel.end}"></div>
          <div class="field"><span class="label">Length</span><span class="mono" style="padding-top:10px">${secs(dur)} ${dur < 4000 || dur > 8000 ? html`<span class="badge yellow">outside 4–8s</span>` : html`<span class="badge green">✓ 4–8s</span>`}</span></div>
        </div>
        <div class="field"><label for="tr">Transcript (exact words spoken)</label><textarea class="input" id="tr" name="transcript">${s.transcript}</textarea></div>
        <div class="form-grid">
          <div class="field"><label for="tp">Topic</label><input class="input" id="tp" name="topic" value="${s.topic}"></div>
          <div class="field"><label for="df">Difficulty</label><select class="input" id="df" name="difficulty">${Object.entries(DIFF).map(([v, l]) => html`<option value="${v}" ${s.difficulty === v ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div class="field"><label for="ms">Main skill</label><select class="input" id="ms" name="main_skill_tag">${Object.entries(SKILL_LABEL).map(([v, l]) => html`<option value="${v}" ${s.main_skill_tag === v ? 'selected' : ''}>${l}</option>`)}</select></div>
          <div class="field"><label for="fm">Familiarity (whole class)</label><select class="input" id="fm" name="familiarity_status">
            <option value="unseen" ${s.familiarity_status === 'unseen' ? 'selected' : ''}>Unseen</option>
            <option value="previously_practised" ${s.familiarity_status === 'previously_practised' ? 'selected' : ''}>Previously practised</option></select></div>
        </div>
        <fieldset class="field"><legend class="label">Secondary skills</legend><div class="row">
          ${Object.entries(SKILL_LABEL).map(([v, l]) => html`<label class="check"><input type="checkbox" name="secondary" value="${v}" ${s.secondary_skill_tags.includes(v) ? 'checked' : ''}> ${l}</label>`)}</div></fieldset>
        <div class="row"><button class="btn btn-primary" type="submit">${editing ? 'Save changes' : 'Save segment'}</button>
          <span class="hint">Saving cuts a separate clip. Students only ever receive that clip, never the full recording.</span></div>
      </form>`;
  }

  function render() {
    setHtml(root, html`
      <p><a href="#/t/audio">← Audio Library</a></p>
      <div class="page-head"><div><span class="eyebrow">Recording · ${msToClock(audio.duration_ms)}</span><h1>${audio.title}</h1>
        <p class="muted">${audio.source}${audio.rights_note ? ` · ${audio.rights_note}` : ''}</p></div>
        ${audio.archived_at ? '' : html`<button class="btn btn-ghost" data-archive>Archive</button>`}</div>
      <div class="grid-2">
        ${segForm()}
        <form class="card stack" data-transcript>
          <h2>Full transcript</h2>
          <p class="hint">For your reference while cutting segments. Never shown to students in assessments.</p>
          <textarea class="input" name="transcript" style="min-height:300px">${audio.transcript}</textarea>
          <div><button class="btn btn-blue" type="submit">Save transcript</button></div>
        </form>
      </div>
      <section class="section">
        <h2 style="margin-bottom:10px">Segments <span class="count-dot">${audio.segments.length}</span></h2>
        ${audio.segments.length ? html`<div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Time</th><th>Transcript</th><th>Skill</th><th>Status</th><th>Used</th><th></th></tr></thead>
          <tbody>${audio.segments.map((s) => html`<tr>
            <td class="mono">${s.segment_id}</td>
            <td class="mono small">${msToClock(s.start_ms)}–${msToClock(s.end_ms)}<div class="tiny muted">${secs(s.duration_ms)}</div></td>
            <td>${s.transcript || html`<span class="muted">(no transcript)</span>`}<div class="tiny muted">${s.topic} · ${DIFF[s.difficulty]} · ${s.familiarity_status === 'unseen' ? 'Unseen' : 'Practised'}</div></td>
            <td class="small">${SKILL_LABEL[s.main_skill_tag]}</td>
            <td>${s.verification_status === 'verified' ? html`<span class="badge green">✓ Verified</span>` : html`<span class="badge yellow">✎ Draft</span>`}</td>
            <td class="small">${s.used_in_tests ? `${s.used_in_tests} test${s.used_in_tests > 1 ? 's' : ''}` : '—'}${s.in_attempts ? html`<div class="tiny muted">🔒 assessed</div>` : ''}</td>
            <td><div class="row" style="gap:4px">
              <button class="btn btn-ghost btn-sm" data-clip="${s.segment_id}">▶ Clip</button>
              ${s.in_attempts ? '' : html`<button class="btn btn-ghost btn-sm" data-edit="${s.segment_id}">Edit</button>`}
              ${s.verification_status === 'verified' ? '' : html`<button class="btn btn-blue btn-sm" data-verify="${s.segment_id}">Verify</button>`}
              <button class="btn btn-ghost btn-sm" data-exposure="${s.segment_id}">Students</button>
            </div></td></tr>`)}</tbody></table></div>`
          : emptyState(IMG.unsure, 'No segments yet', 'Set a start and end on the recording, add the transcript and save.')}
      </section>
      <div data-exposure-panel></div>`);
    wire();
  }

  function readSel() {
    sel = { start: Number(root.querySelector('#st').value), end: Number(root.querySelector('#en').value) };
  }

  function wire() {
    const form = root.querySelector('[data-seg]');
    form.querySelectorAll('#st, #en').forEach((i) => i.addEventListener('change', () => { readSel(); keepForm(); }));
    form.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.p;
      if (p === 'play') { stopAt = null; player.paused ? player.play() : player.pause(); }
      if (p === 'back') player.currentTime = Math.max(0, player.currentTime - 1);
      if (p === 'fwd') player.currentTime = Math.min(audio.duration_ms / 1000, player.currentTime + 1);
      if (p === 'setStart') { sel.start = Math.round(player.currentTime * 1000); keepForm(); }
      if (p === 'setEnd') { sel.end = Math.round(player.currentTime * 1000); keepForm(); }
      if (p === 'preview') { readSel(); player.currentTime = sel.start / 1000; stopAt = sel.end; player.play(); }
    }));
    form.querySelector('[data-cancel]')?.addEventListener('click', () => { editing = null; draft = null; render(); });
    form.addEventListener('submit', saveSegment);
    root.querySelector('[data-transcript]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { audio = await patch(`/api/teacher/audio/${id}`, { transcript: new FormData(e.target).get('transcript') }); toast('Transcript saved'); } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelector('[data-archive]')?.addEventListener('click', async () => {
      if (!(await confirmModal({ title: 'Archive this recording?', body: 'Existing segments and tests keep working.', confirmLabel: 'Archive' }))) return;
      await post(`/api/teacher/audio/${id}/archive`);
      location.hash = '#/t/audio';
    });
    root.querySelectorAll('[data-clip]').forEach((b) => b.addEventListener('click', () => {
      player.pause();
      audioUrl(`/api/teacher/segments/${b.dataset.clip}/clip`).then((u) => new Audio(u).play()).catch(() => toast('Clip could not be played.', 'error'));
    }));
    root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      editing = audio.segments.find((s) => s.segment_id === Number(b.dataset.edit));
      draft = null;
      sel = { start: editing.start_ms, end: editing.end_ms };
      render();
      root.querySelector('[data-seg]').scrollIntoView({ behavior: 'smooth' });
    }));
    root.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', () => verify(Number(b.dataset.verify))));
    root.querySelectorAll('[data-exposure]').forEach((b) => b.addEventListener('click', () => exposure(Number(b.dataset.exposure))));
  }

  /** Re-render while keeping the typed metadata. */
  function keepForm() {
    const f = new FormData(root.querySelector('[data-seg]'));
    draft = {
      transcript: f.get('transcript'), topic: f.get('topic'), difficulty: f.get('difficulty'), main_skill_tag: f.get('main_skill_tag'),
      familiarity_status: f.get('familiarity_status'), secondary_skill_tags: f.getAll('secondary'),
    };
    render();
  }

  async function saveSegment(e) {
    e.preventDefault();
    readSel();
    const f = new FormData(e.target);
    const body = {
      start_ms: sel.start, end_ms: sel.end, transcript: f.get('transcript'), topic: f.get('topic'), difficulty: f.get('difficulty'),
      main_skill_tag: f.get('main_skill_tag'), familiarity_status: f.get('familiarity_status'), secondary_skill_tags: f.getAll('secondary'),
    };
    try {
      if (editing?.segment_id) await patch(`/api/teacher/segments/${editing.segment_id}`, body);
      else await post(`/api/teacher/audio/${id}/segments`, body);
      toast('Segment saved — preview the clip, then verify it.');
      editing = null;
      draft = null;
      sel = { start: sel.end, end: Math.min(sel.end + 6000, audio.duration_ms) };
      audio = await get(`/api/teacher/audio/${id}`);
      render();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function verify(segId) {
    try {
      await post(`/api/teacher/segments/${segId}/verify`, {});
    } catch (err) {
      if (err.code !== 'DURATION_OUTSIDE_RECOMMENDED') return toast(err.message, 'error');
      if (!(await confirmModal({ title: 'Verify anyway?', body: err.message, confirmLabel: 'Verify' }))) return;
      try { await post(`/api/teacher/segments/${segId}/verify`, { overrideDuration: true }); } catch (e2) { return toast(e2.message, 'error'); }
    }
    toast('Verified');
    audio = await get(`/api/teacher/audio/${id}`);
    render();
  }

  async function exposure(segId) {
    const show = (rows) => {
      const panel = root.querySelector('[data-exposure-panel]');
      setHtml(panel, html`<section class="section card stack">
        <h2>Per-student familiarity — segment #${segId}</h2>
        <p class="small muted">Mark audio a student already practised (e.g. in class). Anything a student has heard or whose transcript they have seen is always “practised”.</p>
        <table><thead><tr><th>Student</th><th>Heard in app</th><th>Saw transcript</th><th>Practised</th></tr></thead><tbody>
        ${rows.map((r) => { const real = r.first_heard_at || r.transcript_seen_at; return html`<tr><td>${r.display_name}</td>
          <td class="small">${fmtDateTime(r.first_heard_at)}</td><td class="small">${fmtDateTime(r.transcript_seen_at)}</td>
          <td><label class="check"><input type="checkbox" data-stu="${r.student_id}" ${real || r.marked_by_teacher ? 'checked' : ''} ${real ? 'disabled' : ''}> ${real ? 'Yes (real exposure)' : 'Practised'}</label></td></tr>`; })}
        </tbody></table></section>`);
      panel.querySelectorAll('[data-stu]').forEach((c) => c.addEventListener('change', async () => {
        try { show((await post(`/api/teacher/segments/${segId}/exposure`, { studentId: Number(c.dataset.stu), practised: c.checked })).students); } catch (err) { toast(err.message, 'error'); }
      }));
      panel.scrollIntoView({ behavior: 'smooth' });
    };
    show((await get(`/api/teacher/segments/${segId}/exposure`)).students);
  }

  if (!students.length) toast('Tip: create student accounts to track per-student familiarity.');
  render();
  return () => player.pause();
}
