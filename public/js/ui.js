class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template: interpolations are escaped unless wrapped in raw(); arrays are joined. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += fmt(vals[i]);
  });
  return new Raw(out);
}
function fmt(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  if (v === false || v === null || v === undefined) return '';
  return esc(v);
}

export const IMG = {
  mascot: '/img/unio-mascot.png',
  listening: '/img/unio-listening.png',
  writing: '/img/unio-writing.png',
  progress: '/img/unio-progress.png',
  online: '/img/unio-online-learning.png',
  hello: '/img/unio-11-chao-ngay-moi.png',
  congrats: '/img/unio-02-chuc-mung.png',
  sleepy: '/img/unio-03-buon-ngu.png',
  worried: '/img/unio-04-lo-lang.png',
  sorry: '/img/unio-07-xin-loi.png',
  unsure: '/img/unio-01-phan-van.png',
  huh: '/img/unio-09-ua-la-sao.png',
  startled: '/img/unio-10-het-hon.png',
};

const TZ = 'Asia/Ho_Chi_Minh';
const dFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const dtFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const tFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDate = (ms) => (ms == null ? '—' : dFmt.format(new Date(ms)));
export const fmtDateTime = (ms) => (ms == null ? '—' : dtFmt.format(new Date(ms)));
export const fmtTime = (ms) => (ms == null ? '—' : tFmt.format(new Date(ms)));
export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
export function msToClock(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}
/** datetime-local value (in the plan timezone, UTC+7) <-> epoch ms */
export function toLocalInput(ms) {
  if (ms == null) return '';
  return new Date(ms + 7 * 3600e3).toISOString().slice(0, 16);
}
export function fromLocalInput(v) {
  return v ? Date.parse(`${v}:00+07:00`) : null;
}

export function toast(message, kind = 'info') {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  wrap.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function confirmModal({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', img = IMG.unsure }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = String(html`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <img src="${img}" alt="">
        <h2 id="m-title">${title}</h2>
        ${body ? html`<p class="muted">${body}</p>` : ''}
        <div class="row">
          ${cancelLabel ? html`<button class="btn btn-ghost" data-v="0">${cancelLabel}</button>` : ''}
          <button class="btn btn-primary" data-v="1">${confirmLabel}</button>
        </div>
      </div>`);
    const prev = document.activeElement;
    const done = (v) => { overlay.remove(); prev?.focus?.(); resolve(v); };
    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) done(b.dataset.v === '1');
    });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cancelLabel) done(false); });
    document.body.append(overlay);
    overlay.querySelector('[data-v="1"]').focus();
  });
}

const STATUS = {
  locked: ['Locked', '🔒', ''],
  available: ['Available', '▶', 'blue'],
  in_progress: ['In progress', '◐', 'yellow'],
  submitted: ['Submitted', '✓', 'green'],
  review_required: ['Review required', '!', 'coral'],
  completed: ['Completed', '★', 'green'],
  overdue: ['Overdue', '⏰', 'coral'],
  not_assigned: ['Not assigned', '–', ''],
  not_started: ['Not started', '○', ''],
};
export function statusBadge(status) {
  const [label, icon, cls] = STATUS[status] ?? [status, '•', ''];
  return html`<span class="badge ${cls}"><span class="ic" aria-hidden="true">${icon}</span>${label}</span>`;
}

export const MODE_LABEL = { recovery: 'Recovery', training: 'Training', transfer: 'Transfer' };
export function modeBadge(mode) {
  if (!mode) return '';
  const cls = { recovery: 'pink', training: 'blue', transfer: 'green' }[mode];
  return html`<span class="badge ${cls}">${MODE_LABEL[mode]}</span>`;
}
export const SKILL_LABEL = {
  word_recognition: 'Word Recognition', speech_segmentation: 'Speech Segmentation',
  connected_speech: 'Connected Speech', information_processing: 'Information Processing',
};

export function emptyState(img, title, text = '') {
  return html`<div class="empty"><img src="${img}" alt=""><div><h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}</div></div>`;
}

/** Single-series bar chart (values 0..1) with hover tooltips and a table fallback for screen readers. */
export function barChart(points, { caption }) {
  if (!points.length) return '';
  return html`
    <figure class="card">
      <figcaption class="small muted" style="margin-bottom:6px">${caption}</figcaption>
      <div class="bars" aria-hidden="true">
        ${[1, 0.5].map((g) => html`<div class="gridline" style="bottom:${g * 100}%"><span>${pct(g)}</span></div>`)}
        ${points.map((p) => html`
          <div class="bar-col" tabindex="0">
            <div class="bar" style="height:${Math.max(1, (p.value ?? 0) * 100)}%"></div>
            <div class="tip">${p.tip}</div>
          </div>`)}
      </div>
      <div class="bar-labels" aria-hidden="true">${points.map((p) => html`<span>${p.label}</span>`)}</div>
      <table class="sr-only"><caption>${caption}</caption>
        <tr><th>Item</th><th>Value</th></tr>
        ${points.map((p) => html`<tr><td>${p.label}</td><td>${pct(p.value)}</td></tr>`)}
      </table>
    </figure>`;
}

export function hbar(value) {
  return html`<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="hbar" style="flex:1"><i style="width:${(value ?? 0) * 100}%"></i></div><span class="mono small">${pct(value)}</span></div>`;
}

export function setHtml(el, content) { el.innerHTML = String(content); }

export function errorView(err) {
  return emptyState(IMG.sorry, 'Something went wrong', err?.message || 'Please reload and try again.');
}
