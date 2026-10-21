export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'ERROR';
    this.body = body?.error || {};
  }
}

const TOKEN_KEY = 'cp-token';
export const authToken = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(t) { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};
export function authHeaders() {
  const t = authToken.get();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Fetch an authenticated audio file and return a playable object URL (works without cookies). */
export async function audioUrl(url) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: authHeaders() });
  if (!res.ok) throw new Error(`Audio could not be loaded (${res.status}).`);
  return URL.createObjectURL(await res.blob());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON API call. Mutations carry the client header; `idempotent` attaches one key that is reused
 * across automatic retries, so a dropped connection can never cause a duplicate submission.
 */
export async function api(method, url, body, { idempotent = false, retries = idempotent ? 3 : 0, raw = false, headers = {} } = {}) {
  const key = idempotent ? crypto.randomUUID() : null;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {
          ...(raw ? {} : { 'Content-Type': 'application/json' }),
          'X-CP-Client': '1',
          ...authHeaders(),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw new ApiError(0, { error: { code: 'NETWORK', message: 'No connection. Your answer is still here — check your internet and try again.' } });
    }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (res.ok) return data;
    if (res.status >= 500 && attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('cp:unauthenticated'));
    throw new ApiError(res.status, data);
  }
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}, opts) => api('POST', url, body, opts);
export const patch = (url, body = {}) => api('PATCH', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

/** Fire-and-forget activity event that survives the page being hidden or closed. */
export function sendEvent(sessionId, type, metadata = {}) {
  if (!sessionId) return;
  fetch('/api/cp/events', {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CP-Client': '1', ...authHeaders() },
    body: JSON.stringify({ sessionId, type, clientTs: Date.now(), metadata }),
  }).catch(() => {});
}

export function interruptPlayback(token, reason) {
  if (!token) return;
  fetch(`/api/cp/playback/${token}/interrupt`, {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CP-Client': '1', ...authHeaders() },
    body: JSON.stringify({ reason }),
  }).catch(() => {});
}

/** The assessment session this browser tab holds, so a reload is recognized as the same tab. */
export const tabSession = {
  get(scope) { try { return sessionStorage.getItem(`cp-session:${scope}`); } catch { return null; } },
  set(scope, id) { try { sessionStorage.setItem(`cp-session:${scope}`, id); } catch { /* private mode */ } },
};

/** Non-authoritative local copy of a draft, used only if the server copy could not be saved. */
export const localDraft = {
  get(key) { try { return JSON.parse(localStorage.getItem(`cp-draft:${key}`)); } catch { return null; } },
  set(key, text) { try { localStorage.setItem(`cp-draft:${key}`, JSON.stringify({ text, at: Date.now() })); } catch { /* ignore */ } },
  clear(key) { try { localStorage.removeItem(`cp-draft:${key}`); } catch { /* ignore */ } },
};
