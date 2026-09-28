// PostgreSQL frontend/backend protocol v3 — encoding, decoding and SCRAM auth.
//
// ROUTE+ has no npm dependencies, and Node has no built-in PostgreSQL driver,
// so this module speaks the wire protocol directly with node:net / node:crypto.
// It implements exactly what ROUTE+ needs and nothing more:
//   • startup, optional TLS upgrade, ParameterStatus / BackendKeyData
//   • authentication: trust, cleartext, MD5 and SCRAM-SHA-256 (what managed
//     PostgreSQL services use today)
//   • the extended query protocol, so EVERY value is sent as a bound parameter
//     and never concatenated into SQL
//   • text-format results decoded by type OID
//
// Reference: PostgreSQL "Frontend/Backend Protocol", RFC 5802 (SCRAM), RFC 7677.

import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 196608;   // 3.0
export const SSL_REQUEST_CODE = 80877103;

// ------------------------------------------------------------------ encoding
/** Build one frontend message: [type][int32 length][payload]. */
export function message(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(type ? 5 : 4);
  let at = 0;
  if (type) head.writeUInt8(type.charCodeAt(0), at++);
  head.writeInt32BE(payload.length + 4, at);
  return Buffer.concat([head, payload]);
}

const cstr = s => Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]);
export const cstring = cstr;

export function startupMessage(params) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeInt32BE(PROTOCOL_VERSION, 0);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(cstr(k), cstr(v));
  }
  parts.push(Buffer.from([0]));
  return message(null, Buffer.concat(parts).subarray(0));
}

export function sslRequest() {
  const body = Buffer.alloc(8);
  body.writeInt32BE(8, 0);
  body.writeInt32BE(SSL_REQUEST_CODE, 4);
  return body;
}

/** Extended query: Parse + Bind + Describe + Execute + Sync, all params bound. */
export function queryMessages(sql, params = []) {
  const parse = message('P', Buffer.concat([cstr(''), cstr(sql), int16(0)]));

  const values = params.map(v => (v === null || v === undefined ? null : Buffer.from(encodeParam(v), 'utf8')));
  const bind = message('B', Buffer.concat([
    cstr(''), cstr(''),
    int16(0),                                   // all parameters in text format
    int16(values.length),
    ...values.map(b => (b === null ? int32(-1) : Buffer.concat([int32(b.length), b]))),
    int16(0)                                    // all results in text format
  ]));
  const describe = message('D', Buffer.concat([Buffer.from('P'), cstr('')]));
  const execute = message('E', Buffer.concat([cstr(''), int32(0)]));
  const sync = message('S');
  return Buffer.concat([parse, bind, describe, execute, sync]);
}

/** Simple query ('Q') — used only for DDL scripts with no parameters. */
export const simpleQuery = sql => message('Q', cstr(sql));
export const terminate = () => message('X');

/** JS value → the text PostgreSQL expects for a bound parameter. */
export function encodeParam(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const int16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; };
const int32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };

// ------------------------------------------------------------------ decoding
/**
 * Split a stream buffer into complete backend messages.
 * @returns {{ messages: {type: string, body: Buffer}[], rest: Buffer }}
 */
export function readMessages(buffer) {
  const messages = [];
  let at = 0;
  while (buffer.length - at >= 5) {
    const length = buffer.readInt32BE(at + 1);
    if (buffer.length - at < length + 1) break;
    messages.push({ type: String.fromCharCode(buffer[at]), body: buffer.subarray(at + 5, at + 1 + length) });
    at += length + 1;
  }
  return { messages, rest: buffer.subarray(at) };
}

/** Read the NUL-terminated strings of an ErrorResponse / NoticeResponse. */
export function readFields(body) {
  const out = {};
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const code = String.fromCharCode(body[at++]);
    const end = body.indexOf(0, at);
    out[code] = body.subarray(at, end).toString('utf8');
    at = end + 1;
  }
  return out;
}

export function readRowDescription(body) {
  const count = body.readInt16BE(0);
  const fields = [];
  let at = 2;
  for (let i = 0; i < count; i++) {
    const end = body.indexOf(0, at);
    const name = body.subarray(at, end).toString('utf8');
    at = end + 1;
    fields.push({ name, typeOid: body.readInt32BE(at + 6) });
    at += 18;
  }
  return fields;
}

export function readDataRow(body, fields) {
  const count = body.readInt16BE(0);
  const row = {};
  let at = 2;
  for (let i = 0; i < count; i++) {
    const length = body.readInt32BE(at);
    at += 4;
    const field = fields[i] || { name: `column${i}`, typeOid: 25 };
    row[field.name] = length === -1 ? null : decodeValue(body.subarray(at, at + length).toString('utf8'), field.typeOid);
    if (length > 0) at += length;
  }
  return row;
}

// Type OIDs ROUTE+ actually stores. Anything else stays a string, which is
// always safe — the application layer knows what it wrote.
const BOOL = 16, INT8 = 20, INT2 = 21, INT4 = 23, JSON_ = 114, FLOAT4 = 700, FLOAT8 = 701,
  JSONB = 3802, NUMERIC = 1700, TIMESTAMP = 1114, TIMESTAMPTZ = 1184;

export function decodeValue(text, oid) {
  switch (oid) {
    case BOOL: return text === 't';
    case INT2: case INT4: return Number.parseInt(text, 10);
    case INT8: { const n = Number.parseInt(text, 10); return Number.isSafeInteger(n) ? n : BigInt(text); }
    case FLOAT4: case FLOAT8: case NUMERIC: return Number.parseFloat(text);
    case JSON_: case JSONB: try { return JSON.parse(text); } catch { return text; }
    // ISO strings everywhere, so PostgreSQL rows read like the SQLite rows.
    case TIMESTAMP: case TIMESTAMPTZ: { const d = new Date(text.includes('+') || text.endsWith('Z') ? text : `${text}Z`); return Number.isNaN(+d) ? text : d.toISOString(); }
    default: return text;
  }
}

// ------------------------------------------------------------------ auth
/** MD5 authentication: md5(md5(password + user) + salt). */
export function md5Password(user, password, salt) {
  const md5 = data => crypto.createHash('md5').update(data).digest('hex');
  return `md5${md5(Buffer.concat([Buffer.from(md5(password + user), 'utf8'), salt]))}`;
}

/**
 * SCRAM-SHA-256 (RFC 5802 / RFC 7677) — the default for PostgreSQL 14+ and for
 * every managed service. The password itself never crosses the wire.
 */
export function createScram(password, nonce = crypto.randomBytes(18).toString('base64')) {
  const clientFirstBare = `n=,r=${nonce}`;
  let state = {};
  return {
    clientNonce: nonce,
    /** The SASLInitialResponse payload body. */
    firstMessage: () => `n,,${clientFirstBare}`,
    /** Handle server-first, return the client-final message. */
    finalMessage(serverFirst) {
      const parsed = Object.fromEntries(serverFirst.split(',').map(p => [p.slice(0, 1), p.slice(2)]));
      if (!parsed.r?.startsWith(nonce)) throw new Error('SCRAM: server nonce does not extend the client nonce');
      const salt = Buffer.from(parsed.s, 'base64');
      const iterations = Number.parseInt(parsed.i, 10);
      if (!Number.isInteger(iterations) || iterations < 1) throw new Error('SCRAM: bad iteration count');

      const saltedPassword = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
      const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
      const clientKey = hmac(saltedPassword, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const withoutProof = `c=biws,r=${parsed.r}`;                       // biws = base64("n,,")
      const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
      const clientSignature = hmac(storedKey, authMessage);
      const proof = Buffer.alloc(clientKey.length);
      for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];
      state = { serverSignature: hmac(hmac(saltedPassword, 'Server Key'), authMessage).toString('base64') };
      return `${withoutProof},p=${proof.toString('base64')}`;
    },
    /** Verify the server proved it knows the password too (mutual auth). */
    verify(serverFinal) {
      const v = serverFinal.split(',').find(p => p.startsWith('v='))?.slice(2);
      if (v !== state.serverSignature) throw new Error('SCRAM: server signature did not verify');
      return true;
    }
  };
}
