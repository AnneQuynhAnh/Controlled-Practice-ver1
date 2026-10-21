import express from 'express';
import { authCookie, clearAuthCookie, login, logout } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { handle } from '../lib/http.js';

export function authRoutes(ctx) {
  const r = express.Router();
  r.post('/login', handle((req, res) => {
    const { token, user } = login(ctx.db, ctx.clock, String(req.body?.username ?? ''), String(req.body?.password ?? ''));
    res.setHeader('Set-Cookie', authCookie(token));
    return { user: { id: user.id, name: user.display_name, role: user.role }, token };
  }));
  r.post('/logout', handle((req, res) => {
    logout(ctx.db, req.authToken);
    res.setHeader('Set-Cookie', clearAuthCookie);
  }));
  r.get('/me', handle((req) => {
    if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.');
    return { user: { id: req.user.id, name: req.user.display_name, role: req.user.role } };
  }));
  return r;
}
