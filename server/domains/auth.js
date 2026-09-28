// AUTH domain: sign up, log in, log out, sessions, profile.
// • passwords hashed with scrypt + per-user salt (Node crypto, no library)
// • session = random 256-bit token in an HttpOnly, SameSite=Lax cookie;
//   only its SHA-256 hash is stored, so a database leak does not leak sessions
// • generic error messages so attackers cannot probe which emails exist

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, cookie, parseCookies } from '../lib/http.js';
import { now, newId } from '../db/database.js';

const COOKIE = 'rp_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const DUMMY_HASH = hashPassword('route-plus-timing-equaliser');
const sha256 = v => createHash('sha256').update(v).digest('hex');
const publicUser = u => u && ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role, createdAt: u.created_at });

export function createAuth({ db, config, audit }) {
  const findByEmail = email => db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  function startSession(res, userId, req) {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.sessionDays * 86400_000);
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, now(), expires.toISOString(), String(req.headers['user-agent'] || '').slice(0, 200));
    res.setHeader('Set-Cookie', cookie(COOKIE, token, { maxAgeSec: config.sessionDays * 86400, secure: config.secureCookies }));
  }

  /** Attach req.user if the session cookie is valid. */
  function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
    return row ? publicUser(row) : null;
  }

  function validateCredentials(body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'WEAK_PASSWORD', 'Use a password with at least 8 characters.');
    return { email, password };
  }

  return {
    authenticate,
    async signup(req, res, body) {
      const { email, password } = validateCredentials(body);
      const displayName = String(body.displayName || email.split('@')[0]).trim().slice(0, 60) || 'Traveller';
      if (findByEmail(email)) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Try signing in.');
      const id = newId('usr');
      const role = config.adminEmails.includes(email) ? 'admin' : 'traveller';
      db.prepare('INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, email, hashPassword(password), displayName, role, now(), now());
      db.prepare('INSERT INTO user_preferences (user_id, interests, updated_at) VALUES (?, ?, ?)').run(id, '[]', now());
      startSession(res, id, req);
      audit(id, 'user.signup', id);
      return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
    },
    async login(req, res, body) {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password || password.length > 200) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const user = findByEmail(email);
      // Always run scrypt so response time does not reveal whether the email exists.
      const ok = user ? verifyPassword(password, user.password_hash) : (verifyPassword(password, DUMMY_HASH), false);
      if (!ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      startSession(res, user.id, req);
      audit(user.id, 'user.login', user.id);
      return { user: publicUser(user) };
    },
    logout(req, res) {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      res.setHeader('Set-Cookie', cookie(COOKIE, '', { maxAgeSec: 0, secure: config.secureCookies }));
      return { ok: true };
    },
    updateProfile(user, body) {
      const name = String(body.displayName || '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'INVALID_NAME', 'Please enter a name.');
      db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(name, now(), user.id);
      return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
    },
    purgeExpired: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes
  };
}
