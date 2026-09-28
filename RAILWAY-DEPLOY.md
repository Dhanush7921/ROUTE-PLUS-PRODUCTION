# ROUTE+ → Railway

Everything in this folder is ready to deploy. Three steps need your account.

## What is already configured

| File | What it does |
|---|---|
| `Dockerfile` | Builds the image. Node 22 alpine, no npm install (zero dependencies). |
| `docker-entrypoint.sh` | Chowns the mounted volume, then drops to the non-root `routeplus` user. Without this a Railway volume mounted at `/data` leaves the app unable to write. |
| `railway.json` | Dockerfile builder · health check `/api/health` · restart `ON_FAILURE` (10 retries) · 1 replica (required with a volume). |

The server already reads `process.env.PORT` and binds `0.0.0.0`, so Railway's
injected port works with no code change. Verified here on a non-default port.

## Step 1 — push to GitHub

The repository is initialised and committed (130 files, no `.env`, no database).

```bash
git remote add origin https://github.com/<you>/route-plus.git
git push -u origin main
```

## Step 2 — create the Railway service

New Project → **Deploy from GitHub repo** → pick the repo. Railway reads
`railway.json` and builds the Dockerfile.

## Step 3 — add the volume, THEN the variables

**Volume first** (a redeploy without it writes to ephemeral disk):

- Service → Settings → Volumes → New Volume
- Mount path: `/data`

**Variables** (Settings → Variables):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ROUTE_PLUS_DB` | `/data/routeplus.sqlite` |
| `ADMIN_EMAILS` | the address you will sign up with — it becomes the admin |
| `PUBLIC_URL` | `https://<your-domain>.up.railway.app` — set it after step 4 |
| `TRUST_PROXY` | `1` (Railway terminates TLS in front of the app) |
| `LOG_LEVEL` | `info` |
| `ROUTE_PLUS_CONTACT` | your email — only needed if you later enable OpenStreetMap providers |

Do not set `PORT` or `HOST`; Railway provides the first and the image sets the
second. Leave every Google and provider variable unset for this deployment —
the app runs on offline route data and the curated catalogue and says so.

`PUBLIC_URL` is what turns on Secure cookies, HSTS and the same-origin check for
writes, so set it as soon as the domain exists and redeploy.

## Step 4 — public domain

Service → Settings → Networking → **Generate Domain**. Railway returns
`https://<something>.up.railway.app`.

## Step 5 — verify

```
GET  https://<domain>/api/health        → {"ok":true,"database":"ok"}
```

Then open the site, plan Chennai → Ooty, add a stop, save it. Redeploy from the
Railway dashboard and confirm the trip is still there — that is the volume test,
and it is the one that must not be assumed.

## If the build or boot fails

Read the deploy logs. The app names its own configuration problems:

| In the logs | Meaning | Fix |
|---|---|---|
| `ROUTE_PLUS_DB points inside a temporary directory` | volume missing or wrong mount path | mount the volume at `/data` |
| `DB_NOT_WRITABLE` | volume owned by another user | the entrypoint handles this; check it is executable in the image |
| `DB_UNAVAILABLE` | storage cannot lock files | the volume is not a normal disk — recreate it |
| `NODE_ENV=production without PUBLIC_URL` | warning only | set `PUBLIC_URL` after step 4 |

## Android

Once the domain exists:

```bat
cd C:\Users\Asus\Documents\ROUTE+\ROUTE_PLUS_ANDROID_APP\ROUTE_PLUS_ANDROID_APP
gradlew.bat clean
gradlew.bat assembleDebug -PROUTE_PLUS_URL=https://<your-domain>.up.railway.app
```

The URL is compiled in as `BuildConfig.ROUTE_PLUS_URL`; nothing is hardcoded in
the source. A build whose URL differs from the installed one replaces the saved
address, so updating the app actually moves it off the LAN address.

Output: `app\build\outputs\apk\debug\app-debug.apk` → `adb install -r app-debug.apk`
