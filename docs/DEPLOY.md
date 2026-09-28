# ROUTE+ beta deployment

One Node process, one SQLite file, a reverse proxy for HTTPS. No database
server, no build step beyond `npm run build`, no npm install — there are no
dependencies to install.

Read `docs/BETA.md` first for what a beta includes. This file is how to run it
somewhere real.

## 1. The two things that must be right

**Persistent storage.** `ROUTE_PLUS_DB` must be a file on a disk that survives
a restart and a redeploy. It holds your testers' accounts, saved trips and
feedback. ROUTE+ refuses to start in production if it points at `/tmp`,
`/var/tmp`, `/dev/shm` or `:memory:`, and warns if it is inside the application
directory (which a redeploy replaces). If the directory is missing or not
writable, startup fails with `DB_NOT_WRITABLE` and names the directory.

It must also be **local disk**. SQLite needs file locking, and several ordinary
choices cannot provide it: a network share (SMB/NFS), a cloud-synced folder
(OneDrive, Dropbox, Google Drive) or a mounted/FUSE drive. Those fail at
startup with `DB_UNAVAILABLE`, which names the path and the likely cause — the
underlying driver reports only "disk I/O error", which reads like a corrupt
database and sends you looking in the wrong place. Keep `ROUTE_PLUS_DB` on the
machine's own disk (or a real container volume) and back it up from there.

**HTTPS.** Sessions are cookies. `PUBLIC_URL=https://…` turns on Secure
cookies, HSTS and the cross-site origin check. Terminate TLS at a proxy.

## 2. Environment

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PUBLIC_URL=https://beta.example.com
TRUST_PROXY=1                                   # see §4
ROUTE_PLUS_DB=/var/lib/routeplus/routeplus.sqlite
ADMIN_EMAILS=you@example.com                    # REQUIRED in production
LOG_LEVEL=info
SHUTDOWN_TIMEOUT_MS=10000

# Free provider stack for beta
ROUTE_PLUS_CONTACT=you@example.com              # OpenStreetMap usage policy
ROUTE_PROVIDER=osrm
GEOCODING_PROVIDER=nominatim
PLACE_PROVIDER=overpass
OVERPASS_FALLBACK_URL=https://overpass.kumi.systems/api/interpreter
ROUTE_PLUS_LIVE_PROVIDERS=1                     # also enables Open-Meteo
MAX_DETOUR_CANDIDATES=90
```

Leave every Google variable empty. With no key the adapters are skipped
entirely and the free stack answers — no billing account, no paid call.

The server validates all of this at startup: what cannot work is an error and it
refuses to start, naming the variable; what is merely risky is a `configuration`
warning in the log and in `npm run check:beta`.

## 3. Running it

### systemd (a plain server or VM)

```ini
# /etc/systemd/system/routeplus.service
[Unit]
Description=ROUTE+ beta
After=network.target

[Service]
Type=simple
User=routeplus
WorkingDirectory=/opt/routeplus
EnvironmentFile=/etc/routeplus.env          # chmod 600, owned by root
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
StateDirectory=routeplus                    # creates /var/lib/routeplus
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/routeplus

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /opt/routeplus && sudo rsync -a --exclude data --exclude .git ./ /opt/routeplus/
sudo chown -R routeplus:routeplus /opt/routeplus
sudo systemctl daemon-reload && sudo systemctl enable --now routeplus
journalctl -u routeplus -f
```

### Docker

```bash
docker build -t routeplus:beta .
docker volume create routeplus-data
docker run -d --name routeplus -p 8080:8080 \
  -v routeplus-data:/data \
  --env-file /etc/routeplus.env \
  --restart unless-stopped routeplus:beta
```

The image runs as a non-root user, keeps the database on the `/data` volume, and
its `HEALTHCHECK` calls `/api/health` — so an unhealthy container is one that
cannot reach its own database, not just a slow one. `docker stop` sends SIGTERM,
which ROUTE+ handles gracefully.

## 4. Reverse proxy

The proxy must set `X-Forwarded-For`, and you must set `TRUST_PROXY=1`. Without
both, every visitor looks like the proxy and they all share one rate-limit
bucket — with a handful of testers, they will lock each other out. With
`TRUST_PROXY=1` but no proxy, a client can forge the header.

### Caddy (HTTPS automatically)

```
beta.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name beta.example.com;
    ssl_certificate     /etc/letsencrypt/live/beta.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/beta.example.com/privkey.pem;

    client_max_body_size 2m;          # the API caps JSON bodies at 1 MB

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;       # a live OSRM/Overpass plan can take a while
    }
}
server { listen 80; server_name beta.example.com; return 301 https://$host$request_uri; }
```

## 5. Monitoring

`GET /api/health` → `200` with `{ok: true, database: "ok", providers: {...},
uptimeSec}`, or `503` with `database: "error"` when the database cannot be read.
Point your uptime monitor at it and alert on non-200. It contains provider names
and booleans only — never a key or a connection string.

Logs are one JSON line per request and per provider call. Keys, passwords,
tokens, cookies, `Authorization` headers, credentials embedded in URLs and
`key=…` query parameters are all redacted before the line is written.

Provider health and the product funnel are also on the admin dashboard
(`/admin.html`, for an account whose email is in `ADMIN_EMAILS`).

## 6. Backups

```bash
npm run db:backup                 # → ./backups/routeplus-<timestamp>.sqlite
npm run db:backup -- /mnt/backups
```

It uses SQLite's `VACUUM INTO`, which is safe while the server is running —
unlike copying the file, which can catch a half-written page or miss the WAL.
Take one before every deploy and keep a copy off the server. To restore: stop
ROUTE+, copy the backup over `ROUTE_PLUS_DB`, delete any `-wal` / `-shm` files
beside it, start again.

## 7. Deploying an update

```bash
npm test && npm run test:e2e && npm run build && npm run check:beta   # on your machine
npm run db:backup                                                     # on the server
# copy the new code, keeping ROUTE_PLUS_DB outside it
sudo systemctl restart routeplus        # or: docker restart routeplus
curl -fsS https://beta.example.com/api/health | head -c 200
```

The schema migrates itself on start and is additive, so a restart on an existing
database is safe. Service workers are network-first, so testers get new assets
on their next load without clearing anything.

## 8. If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `cannot start — the configuration has N problem(s)` | a variable cannot work | the message names it |
| `DB_NOT_WRITABLE` | volume missing, or wrong owner | create it; `chown` it to the run user |
| `DB_UNAVAILABLE` | database on a share, synced folder or mounted drive — no file locking | move `ROUTE_PLUS_DB` to local disk or a container volume |
| `/api/health` returns 503 | database unreadable | check the volume is still mounted; restore a backup |
| Testers see "Live map services are currently unavailable" | OSRM/Nominatim/Overpass unreachable or rate-limiting | expected degradation — the app keeps working on offline data; check `npm run check:live` |
| Everyone hits rate limits at once | proxy without `TRUST_PROXY=1` | set it, and make the proxy send `X-Forwarded-For` |
| Discovery returns only curated places | Overpass timed out | lower `OVERPASS_CHUNK_KM`, set `OVERPASS_FALLBACK_URL` |

## Not part of a beta deployment

Paid Google Maps / Routes / Places (adapters present, dormant), paid traffic or
weather, premium tiles, payments, a CDN, autoscaling, and PostgreSQL as the
serving database (the layer exists — `docs/DATABASE.md` — but SQLite serves
requests).
