// ROUTE+ server entry point.  Run:  npm start   (or: node server/index.js)
// Zero npm dependencies: Node's http, crypto and sqlite modules only.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openRuntimeDatabase } from './db/runtime.js';
import { buildProviders, describeProviders } from './providers/index.js';
import { createApp } from './app.js';
import { createLogger } from './lib/observability.js';
import { startScheduledJobs } from './jobs.js';
import { assertConfig } from './lib/validateConfig.js';

/**
 * @param {object} overrides  config overrides (port, dbPath, …)
 * @param {object} env        environment variables
 * @param {object} [options]  { fetchImpl } — TEST ONLY: a stand-in for fetch so
 *   provider behaviour can be exercised without calling a real vendor. Normal
 *   startup passes nothing and the providers use the platform's fetch.
 */
export async function startServer(overrides = {}, env = process.env, { fetchImpl } = {}) {
  // Object.assign keeps the non-enumerable API-key properties of the config.
  const config = Object.assign(loadConfig(env), overrides);
  // Refuse to start on a configuration that cannot work, and say exactly what
  // is wrong. Anything merely risky for a public beta comes back as a warning.
  const configWarnings = assertConfig(config, env);
  const logger = createLogger(config.logLevel);
  const runtime = await openRuntimeDatabase({
    env,
    sqlitePath: config.dbPath
  });
  const db = runtime.db;
  let app;
  const providers = buildProviders(config, { onEvent: e => app?.metrics.provider(e), fetchImpl });
  app = createApp({ config, db, providers, logger });
  const server = http.createServer((req, res) => app.handle(req, res));

  // PRODUCTION DATABASE (Step 6). ROUTE_PLUS_DB_MODE chooses which backend
  // actually serves requests; runtime.mode is that answer. When PostgreSQL is
  // configured we also report whether it is reachable and what it has
  // installed, so a broken connection string is obvious at startup instead of
  // at migration time. Never blocks the server, and never logs the password.
  if (config.postgresConfigured) {
    import('./db/pg/client.js').then(async ({ pgConfig, checkConnection, describeConnection }) => {
      const pg = pgConfig(env);
      const check = await checkConnection(pg);
      if (check.ok) logger.info('postgres', { connection: describeConnection(pg), server: check.server, spatial: check.spatial, postgis: check.postgis, servingRequests: runtime.mode });
      else logger.warn('postgres not reachable', { connection: describeConnection(pg), reason: check.reason });
    }).catch(error => logger.warn('postgres check failed', { reason: error.message }));
  }
  // Every job in jobs.js is async and backend-aware, so the hourly
  // maintenance run belongs on PostgreSQL too: gating it on SQLite meant
  // expired sessions were never purged and daily_metrics never rolled up in
  // postgres mode. The jobs are idempotent (DELETE expired, UPSERT the day's
  // counts, UPDATE ... WHERE flagged = FALSE), so a second instance or an
  // external `npm run worker` running alongside is safe.
  const stopJobs = startScheduledJobs(db, logger);
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  return new Promise(resolve => {
    server.listen(config.port, config.host, () => {
      const { port } = server.address();
      logger.info('ROUTE+ server started', { url: `http://${config.host}:${port}`, db: config.dbPath, providers: providers.summary });
      for (const warning of providers.selection.warnings) logger.warn('provider selection', { warning });
      for (const warning of configWarnings) logger.warn('configuration', { warning });

      // One close path, used by tests and by the signal handlers below.
      let closing = null;
      const close = () => (closing ||= new Promise(done => {
        stopJobs();
        const finish = async () => {
          try {
            await runtime.close();
          } catch {
            /* already closed */
          }
          done();
        };
        // Stop accepting, let in-flight requests finish, then give up waiting so
        // a restart can never hang on one slow connection.
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, config.shutdownTimeoutMs);

        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      }));
      resolve({ server, port, db, app, providers, config, warnings: configWarnings, close });
    });
  });
}

// Started directly (not imported by tests)?
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = createLogger(process.env.LOG_LEVEL || 'info');

  // A single failed promise must not take a beta site down. Log it, keep
  // serving. An uncaught EXCEPTION leaves unknown state, so that one shuts
  // down cleanly instead of limping on.
  process.on('unhandledRejection', reason => logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) }));

  startServer().then(({ port, providers, warnings, close }) => {
    console.log(`\n  ROUTE+ is running →  http://localhost:${port}\n${describeProviders(providers.summary, providers.selection.warnings).replace(/^/gm, '  ')}\n`);
    if (warnings.length) console.log(`${warnings.map(w => `  ! ${w}`).join('\n')}\n`);

    // Graceful shutdown: finish what is in flight, checkpoint the database,
    // then exit. Restarts and deploys stop dropping requests.
    let stopping = false;
    const stop = async (signal, code = 0) => {
      if (stopping) return;
      stopping = true;
      console.log(`\n  ${signal} — shutting down…`);
      await close();
      process.exit(code);
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal));
    process.on('uncaughtException', error => { logger.error('uncaught exception', { message: error.message, stack: error.stack }); stop('uncaughtException', 1); });
  }).catch(error => {
    console.error(`\nCould not start ROUTE+: ${error.message}\n`);
    process.exit(1);
  });
}
