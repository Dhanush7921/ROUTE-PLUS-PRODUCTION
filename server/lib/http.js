// HTTP building blocks for a dependency-free Node server:
// errors, JSON bodies, cookies, security headers and static files.

import fs from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export async function readJson(req, limitBytes = 1_000_000) {
  const type = req.headers['content-type'] || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON with Content-Type: application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAgeSec, secure, httpOnly = true, sameSite = 'Lax', path: p = '/' } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`,
    httpOnly && 'HttpOnly', secure && 'Secure', maxAgeSec !== undefined && `Max-Age=${maxAgeSec}`].filter(Boolean).join('; ');
}

export function securityHeaders(res, { https }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"
  ].join('; '));
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

/** Serve a file from `root`, refusing any path that escapes it. */
export async function serveStatic(res, root, urlPath, { transformHtml } = {}) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const file = path.normalize(path.join(root, decoded.endsWith('/') ? `${decoded}index.html` : decoded));
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  let data;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    data = await fs.readFile(file);
  } catch { return false; }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' && transformHtml) data = Buffer.from(transformHtml(data.toString('utf8')));
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300'
  });
  res.end(data);
  return true;
}
