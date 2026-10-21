// Shared pieces for strict listening screens: play panel, guarded answer box, tab monitoring.
import { post, sendEvent } from './api.js';
import { confirmModal, html, IMG, raw } from './ui.js';

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
const WAVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';

/** Big play button, pip counter and status line. ui comes from strictUi(). */
export function playPanel(ui, { statusText, labelPlay = 'Play', labelReplay = 'Replay' }) {
  const allowed = Number(ui.counter.split('/')[1]);
  const used = Number(ui.counter.split('/')[0]);
  const label = ui.playing ? 'Playing' : ui.playLabel === 'Play' ? labelPlay : labelReplay;
  return html`
    <div class="player">
      <button class="play-btn ${ui.playing ? 'playing' : ''}" data-action="play" ${ui.playEnabled ? '' : 'disabled'}
        aria-label="${ui.playing ? 'Audio playing' : `${label} the complete sentence`}">
        ${raw(ui.playing ? WAVE_ICON : PLAY_ICON)}
        <span class="lbl">${label}</span>
      </button>
      <div class="play-count" aria-label="${used} of ${allowed} listens used">
        ${Array.from({ length: allowed }, (_, i) => html`<span class="pip ${i < used ? 'used' : ''}" aria-hidden="true"></span>`)}
        <span>${ui.counter}</span><span class="small muted" style="font-weight:600">plays</span>
      </div>
      <p class="status-line" aria-live="polite">${statusText}</p>
    </div>`;
}

/**
 * Blocks copy, cut, paste, drag-and-drop and the context menu in an answer box, and records attempts.
 * Clipboard contents are never read.
 */
export function guardAnswerBox(textarea, { sessionId, allowPaste }) {
  if (allowPaste) return;
  const block = (type, via) => (e) => { e.preventDefault(); sendEvent(sessionId, type, { via }); flash(textarea); };
  textarea.addEventListener('paste', block('paste_attempt', 'paste'));
  textarea.addEventListener('drop', block('paste_attempt', 'drop'));
  textarea.addEventListener('copy', block('copy_attempt', 'copy'));
  textarea.addEventListener('cut', block('copy_attempt', 'cut'));
  textarea.addEventListener('dragstart', (e) => e.preventDefault());
  textarea.addEventListener('contextmenu', (e) => e.preventDefault());
  textarea.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') block('paste_attempt', e.inputType)(e);
  });
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('spellcheck', 'false');
}
function flash(el) {
  const note = el.parentElement.querySelector('[data-paste-note]');
  if (note) { note.hidden = false; setTimeout(() => { note.hidden = true; }, 3000); }
}

/**
 * Tab monitoring: when hidden, stop audio and log; when back, log and require Resume.
 * Also sends heartbeats so the server can estimate active time.
 */
export function monitorSession({ sessionId, getPlayer, describe, onReturn }) {
  // Leaving = switching tab (visibilitychange) or switching to another app/window (blur).
  let away = null;
  const title = document.title;
  const leave = (via) => {
    if (away) return;
    away = Date.now();
    const player = getPlayer();
    const during = player?.playing ? 'playback' : describe();
    player?.interrupt('tab_hidden');
    sendEvent(sessionId, 'tab_hidden', { during, via });
    document.title = '⚠ Come back to your test';
  };
  // A focus event means the student is back. A tab becoming visible counts only if the window also has focus
  // (otherwise the focus event that follows will handle it).
  const back = (e) => {
    if (!away || document.visibilityState === 'hidden') return;
    if (e?.type !== 'focus' && !document.hasFocus()) return;
    const hiddenMs = Date.now() - away;
    away = null;
    document.title = title;
    sendEvent(sessionId, 'tab_visible', { hiddenMs });
    onReturn(hiddenMs);
  };
  const onVis = () => (document.visibilityState === 'hidden' ? leave('tab') : back());
  const onBlur = () => leave('window');
  // Closing or reloading the page asks the browser to confirm first.
  const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', back);
  window.addEventListener('beforeunload', onBeforeUnload);
  leaveGuard = () => confirmModal({
    title: 'Leave this activity?',
    body: 'Your work so far is saved, but leaving is recorded for your teacher. If audio is playing, that listen still counts.',
    confirmLabel: 'Leave', cancelLabel: 'Stay', img: IMG.worried,
  });
  const beat = () => post(`/api/cp/sessions/${sessionId}/heartbeat`, { visible: document.visibilityState === 'visible' }).catch(() => {});
  beat();
  const timer = setInterval(beat, 20_000);
  const onUnload = () => getPlayer()?.interrupt('page_closed');
  window.addEventListener('pagehide', onUnload);
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', back);
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onUnload);
    clearInterval(timer);
    document.title = title;
    leaveGuard = null;
  };
}

/** Set while a test or review is running; the router asks it before navigating away. */
let leaveGuard = null;
export const getLeaveGuard = () => leaveGuard;

export function returnOverlay(hiddenMs, { wasPlaying }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = String(html`
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="ret-title">
        <img src="${IMG.startled}" alt="">
        <h2 id="ret-title">You left the test page</h2>
        <p class="muted">You were away for about ${Math.max(1, Math.round(hiddenMs / 1000))} seconds. This has been recorded for your teacher.
        ${wasPlaying ? 'The audio stopped and that listen counts as used.' : ''} Your answer and listens are kept.</p>
        <button class="btn btn-primary" data-resume>Resume</button>
      </div>`);
    el.querySelector('[data-resume]').addEventListener('click', () => { el.remove(); resolve(); });
    document.body.append(el);
    el.querySelector('[data-resume]').focus();
  });
}

export function sessionTakenOver(onTakeOver) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = String(html`
    <div class="modal" role="alertdialog" aria-modal="true">
      <img src="${IMG.huh}" alt="">
      <h2>Opened in another tab or device</h2>
      <p class="muted">Only one copy can be active at a time. Your listens and saved work are kept.</p>
      <div class="row"><a class="btn btn-ghost" href="#/today">Go to Today</a><button class="btn btn-primary" data-take>Continue here</button></div>
    </div>`);
  el.querySelector('[data-take]').addEventListener('click', () => { el.remove(); onTakeOver(); });
  document.body.append(el);
}
