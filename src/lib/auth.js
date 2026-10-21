import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const COOKIE = 'cp_auth';
const SESSION_TTL = 14 * 24 * 3600 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createUser(db, { username, displayName, role, password, now = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, displayName, role, hashPassword(password), now);
  return info.lastInsertRowid;
}

export function login(db, clock, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'INVALID_LOGIN', 'Incorrect username or password.');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const now = clock.now();
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), user.id, now, now + SESSION_TTL);
  return { token, user };
}

export function logout(db, token) {
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function authCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`;
}
export const clearAuthCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function authMiddleware(db, clock) {
  return (req, _res, next) => {
    // The cookie is the normal path; the Bearer header covers embedded previews that drop cookies.
    const bearer = /^Bearer\s+(\S+)$/.exec(req.get('Authorization') || '')?.[1];
    const token = readCookie(req, COOKIE) || bearer || null;
    req.authToken = token;
    req.user = null;
    if (token) {
      const row = db.prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.cp_paste_exception
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`
      ).get(sha256(token), clock.now());
      if (row) req.user = row;
    }
    next();
  };
}

/** Mutations must carry X-CP-Client (blocks cross-site form posts in addition to SameSite=Strict). */
export function csrfGuard(req, _res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-CP-Client') !== '1') {
    return next(new HttpError(403, 'CSRF', 'Missing client header.'));
  }
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this area.'));
    next();
  };
}
