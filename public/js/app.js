import { authToken, get, post } from './api.js';
import { getLeaveGuard } from './listening.js';
import { errorView, html, IMG, raw, setHtml } from './ui.js';

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  home: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  list: svg('<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  repeat: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  headphones: svg('<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 15h3v5H4zM17 15h3v5h-3z"/>'),
  calendar: svg('<path d="M4 6h16v14H4z"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  users: svg('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>'),
  out: svg('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
};
const STUDENT_NAV = [
  ['#/today', 'Today', ICON.home],
  ['#/tests', 'Tests', ICON.list],
  ['#/practice', 'Practice', ICON.headphones],
  ['#/progress', 'My Progress', ICON.chart],
];
const TEACHER_NAV = [
  ['#/t/dashboard', 'Dashboard', ICON.home],
  ['#/t/tests', 'Test Manager', ICON.list],
  ['#/t/audio', 'Audio Library', ICON.headphones],
  ['#/t/assign', 'Assignments', ICON.calendar],
  ['#/t/students', 'Students', ICON.users],
  ['#/t/reviews', 'Reviews', ICON.repeat],
  ['#/t/analytics', 'Analytics', ICON.chart],
];

// [pattern, module, export, { focus }] — focus pages hide navigation (assessment and review screens).
const ROUTES = {
  student: [
    [/^#\/today$/, './student/pages.js', 'today'],
    [/^#\/tests$/, './student/pages.js', 'tests'],
    [/^#\/progress$/, './student/pages.js', 'progress'],
    [/^#\/test\/(\d+)$/, './student/assessment.js', 'testPage', { focus: true }],
    [/^#\/test\/(\d+)\/redo$/, './student/assessment.js', 'redoPage', { focus: true }],
    [/^#\/practice$/, './student/practice.js', 'practiceList'],
    [/^#\/practice\/(\d+)$/, './student/practice.js', 'practicePage'],
    [/^#\/review\/(\d+)$/, './student/review.js', 'reviewPage', { focus: true }],
  ],
  teacher: [
    [/^#\/t\/dashboard$/, './teacher/dashboard.js', 'dashboard'],
    [/^#\/t\/analytics$/, './teacher/dashboard.js', 'analytics'],
    [/^#\/t\/tests$/, './teacher/tests.js', 'testList'],
    [/^#\/t\/tests\/(\d+)$/, './teacher/tests.js', 'testEditor'],
    [/^#\/t\/audio$/, './teacher/audio.js', 'audioLibrary'],
    [/^#\/t\/audio\/(\d+)$/, './teacher/audio.js', 'audioDetail'],
    [/^#\/t\/assign$/, './teacher/assign.js', 'assignments'],
    [/^#\/t\/students$/, './teacher/monitor.js', 'students'],
    [/^#\/t\/students\/(\d+)$/, './teacher/monitor.js', 'studentDetail'],
    [/^#\/t\/attempts\/(\d+)$/, './teacher/monitor.js', 'attemptDetail'],
    [/^#\/t\/reviews$/, './teacher/monitor.js', 'reviewManagement'],
  ],
};

const app = document.getElementById('app');
let user = null;
let cleanup = null;

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('cp-theme', root.dataset.theme); } catch { /* ignore */ }
}

function shell(focus) {
  const nav = user.role === 'teacher' ? TEACHER_NAV : STUDENT_NAV;
  const hash = location.hash;
  const current = (href) => (hash === href || hash.startsWith(`${href}/`) ? 'aria-current="page"' : '');
  return html`
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="${nav[0][0]}">
          <span class="brand-mark"><img src="/img/unio-u.png" alt=""></span>
          <span><span class="brand-name">UNIO</span><span class="brand-sub">Controlled Practice</span></span>
        </a>
        ${focus ? '' : html`<nav class="nav" aria-label="Controlled Practice">
          ${nav.map(([href, label]) => html`<a href="${href}" ${raw(current(href))}>${label}<span data-badge="${href}"></span></a>`)}
        </nav>`}
        <span class="spacer"></span>
        <div class="user-chip">
          <span class="name">${user.name}</span>
          <button class="icon-btn" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">◐</button>
          ${focus ? '' : html`<button class="btn btn-ghost btn-sm" data-logout>Sign out</button>`}
        </div>
        <button class="menu-btn" data-menu aria-expanded="false" aria-controls="drawer" aria-label="Open menu">
          ${raw(ICON.menu)}<span class="menu-dot" data-badge-dot hidden></span>
        </button>
      </div>
    </header>
    <div class="scrim" data-menu-close hidden></div>
    <aside class="drawer" id="drawer" aria-label="Menu" hidden>
      <div class="drawer-head">
        <div><strong>${user.name}</strong><span class="tiny muted">${user.role === 'teacher' ? 'Teacher' : 'Student'}</span></div>
        <button class="icon-btn" data-menu-close aria-label="Close menu">${raw(ICON.close)}</button>
      </div>
      ${focus
        ? html`<p class="small muted drawer-note">You're in the middle of an activity. Your progress is saved.</p>
            <nav class="drawer-nav"><a href="${nav[0][0]}">${raw(ICON.home)}<span>Leave and go to ${nav[0][1]}</span></a></nav>`
        : html`<nav class="drawer-nav" aria-label="Controlled Practice">
            ${nav.map(([href, label, icon]) => html`<a href="${href}" ${raw(current(href))}>${raw(icon)}<span>${label}</span><span data-badge="${href}"></span></a>`)}
          </nav>`}
      <div class="drawer-foot">
        <button class="drawer-item" data-theme-toggle>${raw(ICON.moon)}<span>Dark mode</span></button>
        ${focus ? '' : html`<button class="drawer-item" data-logout>${raw(ICON.out)}<span>Sign out</span></button>`}
      </div>
    </aside>
    <main id="page"><div class="loading">Loading…</div></main>`;
}

function setMenu(open) {
  const drawer = document.getElementById('drawer');
  const btn = document.querySelector('[data-menu]');
  if (!drawer || !btn) return;
  drawer.hidden = !open;
  document.querySelector('.scrim').hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
  (open ? drawer.querySelector('a, button') : btn).focus();
}

async function route() {
  if (!user) return;
  cleanup?.();
  cleanup = null;
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  const table = ROUTES[user.role];
  const hash = location.hash || '';
  const match = table.map(([re, mod, fn, opts]) => ({ m: hash.match(re), mod, fn, opts })).find((r) => r.m);
  if (!match) {
    location.replace(user.role === 'teacher' ? '#/t/dashboard' : '#/today');
    return;
  }
  document.body.classList.toggle('focus', Boolean(match.opts?.focus));
  setHtml(app, shell(match.opts?.focus));
  const page = document.getElementById('page');
  window.scrollTo(0, 0);
  try {
    const mod = await import(match.mod);
    cleanup = (await mod[match.fn](page, match.m.slice(1), { user })) || null;
  } catch (err) {
    console.error(err);
    setHtml(page, errorView(err));
  }
  if (user.role === 'student' && !match.opts?.focus) refreshBadges();
}

async function refreshBadges() {
  try {
    const n = (await get('/api/cp/today')).todo.length;
    if (!n) return;
    document.querySelectorAll('[data-badge="#/today"]').forEach((el) => { el.outerHTML = `<span class="nav-badge" aria-label="${n} things to do">${n}</span>`; });
    const dot = document.querySelector('[data-badge-dot]');
    if (dot) dot.hidden = false;
  } catch { /* badge is optional */ }
}

// Usernames are plain ASCII. With a Vietnamese Telex keyboard on, "teacher" is typed as "teachẻ"
// ("er" becomes a tone mark), so turn Vietnamese letters back into the keys that produced them.
const TONES = { '\u0301': 's', '\u0300': 'f', '\u0309': 'r', '\u0303': 'x', '\u0323': 'j' };
const MARKS = { '\u0302': (c) => c + c, '\u0306': (c) => `${c}w`, '\u031b': (c) => `${c}w` };
function untelex(text) {
  return [...text.normalize('NFD').replace(/đ/g, 'dd').replace(/Đ/g, 'DD')].reduce((out, ch) => {
    if (TONES[ch]) return out + TONES[ch];
    if (MARKS[ch]) return out.slice(0, -1) + MARKS[ch](out.slice(-1));
    return out + ch;
  }, '');
}

function loginView() {
  setHtml(app, html`
    <div class="login">
      <div class="login-art">
        <div>
          <img src="${IMG.listening}" alt="" style="margin:0 auto">
          <h2>Listen. Write. Remember.</h2>
          <p>UNIO Controlled Practice — Union Without End</p>
        </div>
      </div>
      <div class="login-form">
        <form novalidate>
          <div><span class="eyebrow">UNIO</span><h1>Sign in</h1><p class="muted">Controlled Practice for IELTS Listening</p></div>
          <div class="field"><label for="u">Username</label><input class="input" id="u" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" lang="en" required></div>
          <div class="field"><label for="p">Password</label><input class="input" id="p" name="password" type="password" autocomplete="current-password" required></div>
          <p class="error-text" data-err role="alert"></p>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>
      </div>
    </div>`);
  const form = app.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await post('/api/auth/login', { username: untelex(String(fd.get('username')).trim()), password: fd.get('password') });
      user = r.user;
      authToken.set(r.token);
      if (!location.hash || location.hash === '#/login') location.hash = user.role === 'teacher' ? '#/t/dashboard' : '#/today';
      route();
    } catch (err) {
      const typed = `${fd.get('username')}${fd.get('password')}`;
      form.querySelector('[data-err]').textContent = /[^\x00-\x7F]/.test(typed)
        ? `${err.message} Your keyboard may be in Vietnamese (Telex) mode — switch to English (ABC) and try again.`
        : err.message;
    }
  });
  form.querySelector('#u').focus();
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-menu]')) setMenu(document.getElementById('drawer')?.hidden);
  if (e.target.closest('[data-menu-close]') || e.target.closest('.drawer-nav a')) setMenu(false);
  if (e.target.closest('[data-theme-toggle]')) toggleTheme();
  if (e.target.closest('[data-logout]')) {
    await post('/api/auth/logout').catch(() => {});
    authToken.set(null);
    user = null;
    loginView();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('menu-open')) setMenu(false);
});
let currentHash = location.hash;
let restoring = false; // the hash change caused by putting the old hash back
let confirmed = false; // the hash change after the student agreed to leave
window.addEventListener('hashchange', async () => {
  document.body.classList.remove('menu-open');
  if (restoring) { restoring = false; return; }
  const guard = getLeaveGuard();
  if (guard && !confirmed) {
    const target = location.hash;
    restoring = true;
    location.hash = currentHash; // stay on the activity while asking
    if (await guard()) { confirmed = true; location.hash = target; }
    return;
  }
  confirmed = false;
  currentHash = location.hash;
  route();
});
window.addEventListener('cp:unauthenticated', () => { user = null; authToken.set(null); loginView(); });

(async () => {
  try {
    user = (await get('/api/auth/me')).user;
    route();
  } catch {
    loginView();
  }
})();
