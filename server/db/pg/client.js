// PostgreSQL connection for ROUTE+ — one socket, one query at a time.
//
//   const client = await connect(pgConfig(process.env));
//   const { rows } = await client.query('SELECT * FROM places WHERE id = $1', [id]);
//   await client.end();
//
// Zero npm dependencies: node:net, node:tls, node:crypto (see ./protocol.js).
// Every value goes through a BOUND PARAMETER — no SQL is ever built by string
// concatenation, exactly as in the SQLite layer.
//
// SECRETS: the password lives in a closure and on a non-enumerable property of
// the config, so it cannot appear in JSON.stringify, logs, error details or a
// spread copy. `describe()` returns host/port/database/user/ssl only.

import net from 'node:net';
import tls from 'node:tls';
import {
  startupMessage, sslRequest, queryMessages, simpleQuery, terminate, message, cstring,
  readMessages, readFields, readRowDescription, readDataRow, md5Password, createScram
} from './protocol.js';

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C || 'PG_ERROR';
    this.detail = fields.D;
    this.hint = fields.H;
    this.table = fields.t;
    this.constraintName = fields.n;
  }
}

/**
 * Read PostgreSQL settings from the environment.
 * DATABASE_URL wins; otherwise the standard PG* variables.
 * The password is NON-ENUMERABLE — it never lands in a log or a JSON dump.
 */
export function pgConfig(env = process.env) {
  const url = (env.DATABASE_URL || env.POSTGRES_URL || '').trim();
  let parsed = {};
  if (url) {
    const u = new URL(url);
    parsed = {
      host: decodeURIComponent(u.hostname),
      port: Number(u.port) || 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'routeplus',
      user: decodeURIComponent(u.username) || 'routeplus',
      password: decodeURIComponent(u.password || ''),
      sslmode: u.searchParams.get('sslmode') || ''
    };
  }
  const config = {
    host: parsed.host || env.PGHOST || '127.0.0.1',
    port: Number(parsed.port || env.PGPORT || 5432),
    database: parsed.database || env.PGDATABASE || 'routeplus',
    user: parsed.user || env.PGUSER || 'routeplus',
    // require | prefer | disable. Managed services normally need `require`.
    sslmode: (parsed.sslmode || env.PGSSLMODE || 'prefer').toLowerCase(),
    applicationName: env.PGAPPNAME || 'route-plus',
    connectTimeoutMs: Number(env.PGCONNECT_TIMEOUT_MS || 10000),
    statementTimeoutMs: Number(env.PG_STATEMENT_TIMEOUT_MS || 30000),
    configured: Boolean(url || env.PGHOST || env.PGDATABASE)
  };
  Object.defineProperty(config, 'password', { value: parsed.password ?? env.PGPASSWORD ?? '', enumerable: false });
  return config;
}

/** Safe to log: names and booleans only, never the password. */
export const describeConnection = config =>
  `postgres://${config.user}@${config.host}:${config.port}/${config.database} (ssl: ${config.sslmode}, password ${config.password ? 'set' : 'not set'})`;

/** Remove anything password-shaped from text before it can be logged. */
export function scrubDsn(text) {
  return String(text ?? '').replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[redacted]@')
    .replace(/\b(password|pgpassword)\s*=\s*\S+/gi, '$1=[redacted]');
}

/** Open a socket, upgrading to TLS first when the server offers it. */
function openSocket(config) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: config.port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`PostgreSQL connection to ${config.host}:${config.port} timed out`)); }, config.connectTimeoutMs);
    const fail = error => { clearTimeout(timer); socket.destroy(); reject(new Error(scrubDsn(error.message))); };
    socket.once('error', fail);
    socket.once('connect', () => {
      if (config.sslmode === 'disable') { clearTimeout(timer); socket.removeListener('error', fail); return resolve(socket); }
      socket.write(sslRequest());
      socket.once('data', answer => {
        clearTimeout(timer);
        socket.removeListener('error', fail);
        if (answer[0] === 0x53) {                                  // 'S' → TLS
          const secure = tls.connect({ socket, servername: config.host, rejectUnauthorized: config.sslmode === 'verify-full' });
          secure.once('secureConnect', () => resolve(secure));
          secure.once('error', reject);
        } else if (config.sslmode === 'require' || config.sslmode === 'verify-full') {
          socket.destroy();
          reject(new Error('PostgreSQL server refused TLS but PGSSLMODE requires it'));
        } else {
          resolve(socket);
        }
      });
    });
  });
}

/**
 * Connect and authenticate. Resolves to a client with `query`, `exec`,
 * `transaction` and `end`.
 */
export async function connect(config = pgConfig()) {
  const socket = await openSocket(config);
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let handler = null;                 // current message consumer
  const parameters = {};
  let fatal = null;

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, rest } = readMessages(buffer);
    buffer = rest;
    for (const m of messages) {
      if (m.type === 'S') { const f = readFields(m.body); void f; }          // ParameterStatus
      handler?.(m);
    }
  });
  socket.on('error', error => { fatal = new Error(scrubDsn(error.message)); handler?.({ type: 'FATAL', body: Buffer.alloc(0) }); });
  socket.on('close', () => { fatal ||= new Error('PostgreSQL connection closed'); handler?.({ type: 'FATAL', body: Buffer.alloc(0) }); });

  /**
   * Run one exchange: send `payload`, feed messages to `step` until it ends.
   *
   * ReadyForQuery ('Z') terminates EVERY exchange, including a failed one. So
   * an ErrorResponse is remembered and reported when that 'Z' arrives — if we
   * settled on the error immediately, the trailing 'Z' would be read by the
   * NEXT query, which would then finish early with no rows and leave the
   * connection one message out of step for the rest of its life.
   * (During authentication the server sends 'E' and closes without a 'Z';
   * the FATAL path below reports the stored error in that case.)
   */
  const exchange = (payload, step) => new Promise((resolve, reject) => {
    let settled = false;
    let pendingError = null;
    const done = (error, value) => { if (settled) return; settled = true; handler = null; error ? reject(error) : resolve(value); };
    handler = m => {
      if (m.type === 'FATAL') return done(pendingError || fatal || new Error('PostgreSQL connection lost'));
      if (m.type === 'E') { pendingError = new PgError(readFields(m.body)); return; }
      if (m.type === 'N') return;                                            // NoticeResponse: ignore
      if (pendingError && m.type === 'Z') return done(pendingError);
      try { step(m, done); } catch (error) { done(error); }
    };
    if (payload) socket.write(payload);
  });

  // ---- authentication
  let scram;
  await exchange(startupMessage({ user: config.user, database: config.database, application_name: config.applicationName }), (m, done) => {
    if (m.type === 'S') { const f = m.body.toString('utf8').split('\0'); parameters[f[0]] = f[1]; return; }
    if (m.type === 'K') return;                                              // BackendKeyData
    if (m.type === 'Z') return done(null, true);                             // ReadyForQuery
    if (m.type !== 'R') return;
    const code = m.body.readInt32BE(0);
    if (code === 0) return;                                                  // AuthenticationOk
    if (code === 3) return socket.write(message('p', cstring(config.password)));
    if (code === 5) return socket.write(message('p', cstring(md5Password(config.user, config.password, m.body.subarray(4, 8)))));
    if (code === 10) {                                                       // SASL
      const mechanisms = m.body.subarray(4).toString('utf8').split('\0').filter(Boolean);
      if (!mechanisms.includes('SCRAM-SHA-256')) return done(new Error(`Unsupported SASL mechanisms: ${mechanisms.join(', ')}`));
      scram = createScram(config.password);
      const first = Buffer.from(scram.firstMessage(), 'utf8');
      const length = Buffer.alloc(4);
      length.writeInt32BE(first.length, 0);
      return socket.write(message('p', Buffer.concat([cstring('SCRAM-SHA-256'), length, first])));
    }
    if (code === 11) return socket.write(message('p', Buffer.from(scram.finalMessage(m.body.subarray(4).toString('utf8')), 'utf8')));
    if (code === 12) return scram.verify(m.body.subarray(4).toString('utf8'));
    return done(new Error(`Unsupported PostgreSQL authentication request (${code})`));
  });

  /** Parameterised query — the only way ROUTE+ sends values. */
  async function query(sql, params = []) {
    let fields = [];
    const rows = [];
    let command = '';
    await exchange(queryMessages(sql, params), (m, done) => {
      if (m.type === 'T') fields = readRowDescription(m.body);
      else if (m.type === 'D') rows.push(readDataRow(m.body, fields));
      else if (m.type === 'C') command = m.body.toString('utf8').replace(/\0$/, '');
      else if (m.type === 'Z') done(null, true);
    });
    const count = Number.parseInt(command.split(' ').pop(), 10);
    return { rows, rowCount: Number.isFinite(count) ? count : rows.length, command: command.split(' ')[0], fields: fields.map(f => f.name) };
  }

  /** Multi-statement SQL with NO parameters (schema files, extensions). */
  async function exec(sql) {
    const results = [];
    await exchange(simpleQuery(sql), (m, done) => {
      if (m.type === 'C') results.push(m.body.toString('utf8').replace(/\0$/, ''));
      else if (m.type === 'Z') done(null, true);
    });
    return results;
  }

  return {
    parameters,
    serverVersion: () => parameters.server_version || null,
    query,
    exec,
    /** BEGIN / COMMIT / ROLLBACK around `fn`, like tx() in the SQLite layer. */
    async transaction(fn) {
      await exec('BEGIN');
      try { const out = await fn({ query, exec }); await exec('COMMIT'); return out; }
      catch (error) { await exec('ROLLBACK').catch(() => {}); throw error; }
    },
    async end() {
      try { socket.write(terminate()); } catch { /* already gone */ }
      await new Promise(resolve => { socket.end(resolve); setTimeout(resolve, 200); });
    }
  };
}

/**
 * Connect, retrying a few times with a widening delay. A database that is
 * still starting up (a fresh container, a restarted managed instance) is the
 * normal case this exists for; an authentication failure is not retried,
 * because retrying it would only lock the account.
 */
export async function connectWithRetry(config = pgConfig(), { attempts = 5, delayMs = 500, log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await connect(config); }
    catch (error) {
      lastError = error;
      if (error instanceof PgError && ['28P01', '28000', '3D000'].includes(error.code)) throw error; // bad password / role / database
      if (attempt === attempts) break;
      const wait = delayMs * attempt;
      log(`postgres not ready (attempt ${attempt}/${attempts}), retrying in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/**
 * A small pool. Each connection runs one query at a time, so a pool is what
 * lets concurrent work proceed. `size` connections are created lazily and
 * handed out in turn; a broken one is replaced on its next use.
 */
export function createPool(config = pgConfig(), { size = 4 } = {}) {
  const slots = Array.from({ length: Math.max(1, size) }, () => ({ client: null, busy: false }));
  const waiting = [];
  let closed = false;

  const release = slot => {
    slot.busy = false;
    const next = waiting.shift();
    if (next) next();
  };

  async function withClient(fn) {
    if (closed) throw new Error('PostgreSQL pool is closed');
    const slot = slots.find(s => !s.busy) || await new Promise(resolve => waiting.push(() => resolve(slots.find(s => !s.busy))));
    slot.busy = true;
    try {
      if (!slot.client) slot.client = await connectWithRetry(config, { attempts: 2 });
      try { return await fn(slot.client); }
      catch (error) {
        // A transport failure kills the connection; drop it so the next caller
        // gets a fresh one instead of inheriting a dead socket.
        if (!(error instanceof PgError)) { await slot.client.end().catch(() => {}); slot.client = null; }
        throw error;
      }
    } finally { release(slot); }
  }

  return {
    size: slots.length,
    query: (sql, params) => withClient(client => client.query(sql, params)),
    exec: sql => withClient(client => client.exec(sql)),
    transaction: fn => withClient(client => client.transaction(fn)),
    withClient,
    get open() { return slots.filter(s => s.client).length; },
    async end() {
      closed = true;
      await Promise.all(slots.map(async s => { await s.client?.end().catch(() => {}); s.client = null; }));
    }
  };
}

/**
 * Is the configured database reachable, and what is installed on it?
 * Never throws — it reports, so the server can log a warning and carry on.
 */
export async function checkConnection(config = pgConfig()) {
  if (!config.configured) return { ok: false, configured: false, reason: 'No DATABASE_URL / PGHOST configured.' };
  let client;
  try {
    client = await connect(config);
    const { rows: [version] } = await client.query('SELECT version() AS version, current_database() AS database');
    const { rows: extensions } = await client.query('SELECT extname FROM pg_extension ORDER BY extname');
    const names = extensions.map(e => e.extname);
    return {
      ok: true,
      configured: true,
      database: version.database,
      server: String(version.version).split(' ').slice(0, 2).join(' '),
      extensions: names,
      postgis: names.includes('postgis'),
      spatial: names.includes('postgis') ? 'postgis' : names.includes('earthdistance') ? 'earthdistance' : 'none'
    };
  } catch (error) {
    return { ok: false, configured: true, reason: scrubDsn(error.message), code: error.code };
  } finally {
    await client?.end();
  }
}
