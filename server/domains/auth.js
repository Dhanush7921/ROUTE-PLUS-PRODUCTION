// AUTH domain: sign up, log in, log out, sessions, profile.
// • passwords hashed with scrypt + per-user salt (Node crypto, no library)
// • session = random 256-bit token in an HttpOnly, SameSite=Lax cookie;
//   only its SHA-256 hash is stored, so a database leak does not leak sessions
// • generic error messages so attackers cannot probe which emails exist
//
// Database access supports both:
//   SQLite      -> synchronous node:sqlite
//   PostgreSQL  -> asynchronous pooled client

import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, cookie, parseCookies } from '../lib/http.js';
import { now, newId } from '../db/database.js';

const COOKIE = 'rp_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isPostgres = db => typeof db?.query === 'function';

async function one(db, sqliteSql, pgSql, params = []) {
  if (isPostgres(db)) {
    const { rows } = await db.query(pgSql, params);
    return rows[0] ?? null;
  }
  return db.prepare(sqliteSql).get(...params);
}

async function execute(db, sqliteSql, pgSql, params = []) {
  if (isPostgres(db)) {
    return db.query(pgSql, params);
  }
  return db.prepare(sqliteSql).run(...params);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 16384,
    r: 8,
    p: 1
  });
  return timingSafeEqual(expected, actual);
}

const DUMMY_HASH = hashPassword('route-plus-timing-equaliser');
const sha256 = v => createHash('sha256').update(v).digest('hex');

const publicUser = u => u && ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  role: u.role,
  createdAt: u.created_at
});

export function createAuth({ db, config, audit }) {
  // SQLite's users.email is COLLATE NOCASE, so plain equality is already
  // case-insensitive there. PostgreSQL is case-SENSITIVE: its uniqueness comes
  // from a `lower(email)` index, so the lookup has to match on lower(email)
  // too. With plain equality a row stored as "Deva@Example.com" — which the
  // SQLite import quite legitimately produces — is invisible to sign-in, while
  // the unique index still blocks signing up again. The account becomes
  // unreachable. Matching the index also means it is used, not a table scan.
  const findByEmail = async email => one(
    db,
    'SELECT * FROM users WHERE email = ?',
    'SELECT * FROM users WHERE lower(email) = lower($1)',
    [email]
  );

  async function startSession(res, userId, req) {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.sessionDays * 86400_000);

    await execute(
      db,
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [
        sha256(token),
        userId,
        now(),
        expires.toISOString(),
        String(req.headers['user-agent'] || '').slice(0, 200)
      ]
    );

    res.setHeader(
      'Set-Cookie',
      cookie(COOKIE, token, {
        maxAgeSec: config.sessionDays * 86400,
        secure: config.secureCookies
      })
    );
  }

  /** Attach req.user if the session cookie is valid. */
  async function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;

    const row = await one(
      db,
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [sha256(token), now()]
    );

    return row ? publicUser(row) : null;
  }

  function validateCredentials(body) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!EMAIL_RE.test(email) || email.length > 200) {
      throw new HttpError(
        400,
        'INVALID_EMAIL',
        'Please enter a valid email address.'
      );
    }

    if (password.length < 8 || password.length > 200) {
      throw new HttpError(
        400,
        'WEAK_PASSWORD',
        'Use a password with at least 8 characters.'
      );
    }

    return { email, password };
  }

  return {
    authenticate,

    async signup(req, res, body) {
      const { email, password } = validateCredentials(body);
      const displayName =
        String(body.displayName || email.split('@')[0]).trim().slice(0, 60) ||
        'Traveller';

      if (await findByEmail(email)) {
        throw new HttpError(
          409,
          'EMAIL_TAKEN',
          'An account with this email already exists. Try signing in.'
        );
      }

      const id = newId('usr');
      const role = config.adminEmails.includes(email) ? 'admin' : 'traveller';

      try {
        await execute(
          db,
          'INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          'INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [id, email, hashPassword(password), displayName, role, now(), now()]
        );
      } catch (error) {
        // PostgreSQL unique violation for email: preserve the existing API contract.
        if (error?.code === '23505') {
          throw new HttpError(
            409,
            'EMAIL_TAKEN',
            'An account with this email already exists. Try signing in.'
          );
        }
        throw error;
      }

      await execute(
        db,
        'INSERT INTO user_preferences (user_id, interests, updated_at) VALUES (?, ?, ?)',
        'INSERT INTO user_preferences (user_id, interests, updated_at) VALUES ($1, $2, $3)',
        [id, '[]', now()]
      );

      await startSession(res, id, req);

      await audit(id, 'user.signup', id);

      const user = await one(
        db,
        'SELECT * FROM users WHERE id = ?',
        'SELECT * FROM users WHERE id = $1',
        [id]
      );

      return { user: publicUser(user) };
    },

    async login(req, res, body) {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!email || !password || password.length > 200) {
        throw new HttpError(
          401,
          'INVALID_CREDENTIALS',
          'Email or password is incorrect.'
        );
      }

      const user = await findByEmail(email);

      // Always run scrypt so response time does not reveal whether the email exists.
      const ok = user
        ? verifyPassword(password, user.password_hash)
        : (verifyPassword(password, DUMMY_HASH), false);

      if (!ok) {
        throw new HttpError(
          401,
          'INVALID_CREDENTIALS',
          'Email or password is incorrect.'
        );
      }

      await startSession(res, user.id, req);

      await audit(user.id, 'user.login', user.id);

      return { user: publicUser(user) };
    },

    async logout(req, res) {
      const token = parseCookies(req.headers.cookie)[COOKIE];

      if (token) {
        await execute(
          db,
          'DELETE FROM sessions WHERE token_hash = ?',
          'DELETE FROM sessions WHERE token_hash = $1',
          [sha256(token)]
        );
      }

      res.setHeader(
        'Set-Cookie',
        cookie(COOKIE, '', {
          maxAgeSec: 0,
          secure: config.secureCookies
        })
      );

      return { ok: true };
    },

    async updateProfile(user, body) {
      const name = String(body.displayName || '').trim().slice(0, 60);

      if (!name) {
        throw new HttpError(
          400,
          'INVALID_NAME',
          'Please enter a name.'
        );
      }

      await execute(
        db,
        'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
        'UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3',
        [name, now(), user.id]
      );

      const updated = await one(
        db,
        'SELECT * FROM users WHERE id = ?',
        'SELECT * FROM users WHERE id = $1',
        [user.id]
      );

      return { user: publicUser(updated) };
    },

    async purgeExpired() {
      const result = await execute(
        db,
        'DELETE FROM sessions WHERE expires_at <= ?',
        'DELETE FROM sessions WHERE expires_at <= $1',
        [now()]
      );

      return isPostgres(db) ? result.rowCount : result.changes;
    }
  };
}