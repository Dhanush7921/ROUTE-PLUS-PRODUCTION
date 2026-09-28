// ROUTE+ HTTP application: routing, security, and wiring of the domains.
//
//   request → security headers → rate limit → auth (cookie) → route handler
//           → JSON response  |  static file (web/ and shared/)
//
// Each domain lives in server/domains/*. This file only connects them.

import { HttpError, sendJson, readJson, securityHeaders, serveStatic } from './lib/http.js';
import { createMetrics, createRateLimiter } from './lib/observability.js';
import { placesRepo as makePlacesRepo, now } from './db/database.js';
import { createAuth } from './domains/auth.js';
import { createTrips, createPreferences } from './domains/trips.js';
import { createJourneys } from './domains/journeys.js';
import { createInsights } from './domains/insights.js';
import { CATEGORIES } from '../shared/taxonomy.js';

export function createApp({ config, db, providers, logger, extraPlaceProviders = [] }) {
  const metrics = createMetrics();
  const audit = (userId, action, target, detail) =>
    db.prepare('INSERT INTO audit_log (user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(userId ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, now());
  const placesRepo = makePlacesRepo(db);
  const auth = createAuth({ db, config, audit });
  const trips = createTrips({ db, audit });
  const prefs = createPreferences({ db });
  const journeys = createJourneys({ db, providers, extraPlaceProviders, config, onEvent: e => metrics.provider(e) });
  const insights = createInsights({ db, placesRepo, weather: providers.weather });
  const limiter = createRateLimiter({
    auth: { windowMs: 60_000, max: 10 },
    plan: { windowMs: 60_000, max: 30 },
    write: { windowMs: 60_000, max: 120 },
    events: { windowMs: 60_000, max: 240 }
  });

  const requireUser = req => { if (!req.user) throw new HttpError(401, 'AUTH_REQUIRED', 'Please sign in first.'); return req.user; };
  const requireAdmin = req => { const u = requireUser(req); if (u.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Admins only.'); return u; };

  // ------------------------------------------------------------ routes
  // [method, pattern, rateBucket, handler(req, res, params, url)]
  const routes = [
    // Monitoring endpoint. It touches the database, because a server that
    // answers while its storage is broken is worse than one that is plainly
    // down. Names and booleans only — never a key, never a connection string.
    ['GET', '/api/health', null, (req, res) => {
      let database = 'ok';
      try { db.prepare('SELECT 1 AS ok').get(); } catch (error) { database = 'error'; }
      const body = { ok: database === 'ok', name: 'ROUTE+', version: '0.2.0', database, providers: providers.summary, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() };
      if (!body.ok) { res.statusCode = 503; logger.error('health check failed', { database }); }
      return body;
    }],

    // auth & profile
    ['POST', '/api/auth/signup', 'auth', async (req, res) => auth.signup(req, res, await readJson(req))],
    ['POST', '/api/auth/login', 'auth', async (req, res) => auth.login(req, res, await readJson(req))],
    ['POST', '/api/auth/logout', null, (req, res) => auth.logout(req, res)],
    ['GET', '/api/me', null, req => ({ user: req.user, preferences: req.user ? prefs.get(req.user) : null })],
    ['PATCH', '/api/me', 'write', async req => auth.updateProfile(requireUser(req), await readJson(req))],
    ['PUT', '/api/me/preferences', 'write', async req => ({ preferences: prefs.set(requireUser(req), await readJson(req)) })],

    // planning
    ['POST', '/api/plan', 'plan', async req => ({ plan: await journeys.plan(await readJson(req)) })],
    ['GET', '/api/routes/:id', null, (req, res, p) => ({ plan: journeys.getRoute(p.id) })],

    // trips
    ['GET', '/api/trips', null, req => ({ trips: trips.list(requireUser(req)), history: trips.history(req.user) })],
    ['POST', '/api/trips', 'write', async req => ({ trip: trips.save(requireUser(req), await readJson(req)) })],
    ['GET', '/api/trips/:id', null, (req, res, p) => ({ trip: trips.get(requireUser(req), p.id) })],
    ['DELETE', '/api/trips/:id', 'write', (req, res, p) => trips.remove(requireUser(req), p.id)],
    ['POST', '/api/trips/:id/status', 'write', async (req, res, p) => trips.setStatus(requireUser(req), p.id, (await readJson(req)).status)],
    ['POST', '/api/trips/:id/visited', 'write', async (req, res, p) => { trips.markVisited(requireUser(req), p.id, (await readJson(req)).placeId); return { ok: true }; }],

    // places, feedback, analytics, context
    ['GET', '/api/places/near', null, (req, res, p, url) => ({ places: insights.near(Number(url.searchParams.get('lat')), Number(url.searchParams.get('lng')), Number(url.searchParams.get('radiusKm') || 30)) })],
    ['POST', '/api/feedback', 'write', async req => insights.recordFeedback(req.user, await readJson(req))],
    ['POST', '/api/events', 'events', async req => insights.recordEvents(req.user, await readJson(req, 200_000))],
    ['GET', '/api/personalization', null, req => insights.personalization(req.user)],
    ['POST', '/api/context', 'plan', async req => insights.context(await readJson(req))],

    // admin (role = admin)
    ['GET', '/api/admin/overview', null, req => { requireAdmin(req); return { product: insights.productMetrics(30), system: metrics.snapshot() }; }],
    ['GET', '/api/admin/places', null, (req, res, p, url) => { requireAdmin(req); return { places: placesRepo.listAll({ q: url.searchParams.get('q') || '' }), categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label })) }; }],
    ['PATCH', '/api/admin/places/:id', 'write', async (req, res, p) => {
      const admin = requireAdmin(req);
      const body = await readJson(req);
      const allowed = {};
      if (typeof body.name === 'string' && body.name.trim()) allowed.name = body.name.trim().slice(0, 120);
      if (typeof body.description === 'string') allowed.description = body.description.slice(0, 600);
      if (typeof body.caution === 'string') allowed.caution = body.caution.slice(0, 400);
      if (body.category && CATEGORIES[body.category]) allowed.category = body.category;
      if (Number.isInteger(body.visitDurationMinutes) && body.visitDurationMinutes > 0 && body.visitDurationMinutes < 720) allowed.visitDurationMinutes = body.visitDurationMinutes;
      if (typeof body.quality === 'number' && body.quality >= 1 && body.quality <= 5) allowed.quality = body.quality;
      if (!placesRepo.update(p.id, allowed)) throw new HttpError(404, 'NOT_FOUND', 'Place not found.');
      audit(admin.id, 'place.update', p.id, allowed);
      return { place: placesRepo.get(p.id) };
    }],
    ['POST', '/api/admin/places/:id/:action', 'write', async (req, res, p) => {
      const admin = requireAdmin(req);
      const body = await readJson(req).catch(() => ({}));
      const ops = {
        disable: () => placesRepo.setActive(p.id, false), enable: () => placesRepo.setActive(p.id, true),
        flag: () => placesRepo.flag(p.id, String(body.reason || 'Needs review').slice(0, 200)), unflag: () => placesRepo.unflag(p.id)
      };
      if (!ops[p.action]) throw new HttpError(404, 'NOT_FOUND', 'Unknown action.');
      if (!ops[p.action]()) throw new HttpError(404, 'NOT_FOUND', 'Place not found.');
      audit(admin.id, `place.${p.action}`, p.id);
      return { place: placesRepo.get(p.id) };
    }],
    ['GET', '/api/admin/performance', null, req => { requireAdmin(req); return { places: insights.placePerformance(100) }; }],
    ['GET', '/api/admin/feedback', null, req => { requireAdmin(req); return { feedback: insights.recentFeedback(100) }; }],
    ['GET', '/api/admin/audit', null, req => { requireAdmin(req); return { audit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all() }; }]
  ].map(([method, pattern, bucket, handler]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    return { method, re, keys, bucket, handler };
  });

  function match(method, pathname) {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return { pathMatched };
  }

  // Pages served by this server are marked so the browser knows an API exists.
  const markHtml = html => html.replace('<head>', '<head>\n  <meta name="route-plus-api" content="1">');
  // Who is this request from, for rate limiting? Behind a reverse proxy the
  // socket address is the PROXY, so every visitor would share one bucket and a
  // handful of beta testers could lock each other out. With TRUST_PROXY=1 we
  // read the client from X-Forwarded-For instead — the LAST entry, which is the
  // one our own proxy appended and the only one a client cannot forge. Without
  // that setting the header is ignored completely, because trusting it when no
  // proxy is present would let anyone bypass the limits by sending it.
  const clientIp = req => {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  };

  return {
    metrics,
    async handle(req, res) {
      const started = process.hrtime.bigint();
      const url = new URL(req.url, 'http://localhost');
      securityHeaders(res, { https: config.secureCookies });
      let status = 200;
      try {
        if (url.pathname.startsWith('/api/')) {
          // CSRF defence: state-changing requests must come from our own origin.
          if (req.method !== 'GET' && req.headers.origin && config.publicUrl && req.headers.origin !== new URL(config.publicUrl).origin) {
            throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site request blocked.');
          }
          const { route, params, pathMatched } = match(req.method, url.pathname);
          if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', 'Not found.');
          if (route.bucket) {
            const rl = limiter(route.bucket, clientIp(req));
            if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfterSec)); throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment.'); }
          }
          req.user = auth.authenticate(req);
          const body = await route.handler(req, res, params, url);
          // A handler may set res.statusCode to answer with something other
          // than 200 while still returning a normal body (the health check
          // reports 503 with its own detail, so a monitor sees both).
          status = res.statusCode && res.statusCode !== 200 ? res.statusCode : 200;
          sendJson(res, status, body);
          metrics.inc(`api ${req.method} ${route.re.source}`);
        } else {
          const served = url.pathname.startsWith('/shared/')
            ? await serveStatic(res, config.sharedRoot, url.pathname.slice('/shared'.length))
            : await serveStatic(res, config.webRoot, url.pathname, { transformHtml: markHtml });
          if (!served) { status = 404; res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
        }
      } catch (error) {
        const known = error instanceof HttpError;
        status = known ? error.status : 500;
        if (!known) {
          metrics.error(`${req.method} ${url.pathname}`, error);
          logger.error('unhandled', { path: url.pathname, error: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') });
        } else if (status >= 500) metrics.error(`${req.method} ${url.pathname}`, error);
        if (!res.headersSent) {
          sendJson(res, status, { error: known
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
        }
      } finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (url.pathname.startsWith('/api/')) {
          metrics.time(url.pathname.replace(/\/(usr|trp|rte)_[a-z0-9]+/g, '/:id'), ms);
          logger.info('request', { method: req.method, path: url.pathname, status, ms: Math.round(ms), user: req.user?.id });
        }
      }
    }
  };
}
