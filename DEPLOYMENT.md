# Production Deployment

## Free personal deployment

The default `render.yaml` uses **Render Free** and creates no Render database or
paid service. Keep Render on its free workspace and do not add a payment method:
without one, exceeding the included bandwidth suspends free services rather than
charging for more. Do not upgrade or enable paid extras.

Use **Supabase Free** for PostgreSQL and encrypted files:

1. Create a Free project near the Render service (Singapore). Disable the
   **Data API** before the app starts: this app uses its own authentication and
   creates SQL tables without Supabase row-level security policies. Keep Data API
   disabled so those tables cannot be accessed through an anonymous REST API.
2. Use the project's **session pooler** PostgreSQL connection on port 5432 for
   `DATABASE_URL`. It supports IPv4 hosts. Set `PGSSLMODE=require` and retain TLS
   verification. Do not use the transaction pooler when a session connection is
   available. Copy the real connection details from the project dashboard.
3. Create a **private** Storage bucket. Generate server-side S3 access credentials
   and set `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and
   `S3_SECRET_ACCESS_KEY` in Render. Use the endpoint and region from Supabase's
   S3 settings, `S3_FORCE_PATH_STYLE=true`, and `S3_PREFIX=attachments`. Leave
   `S3_SERVER_SIDE_ENCRYPTION` unset. Never put credentials in browser code or Git.
4. Configure the free calling relay described below. Verify the actual account
   offers the free allowance and does not require payment or automatic overages
   before activation. A metered free allowance alone is not a zero-cost guarantee.
5. Set `PUBLIC_ORIGIN=https://chatwithme.space`, a long random `APP_SETUP_CODE`,
   and a private `BACKUP_PASSPHRASE`. Finish authenticated messaging, uploads, and
   forced-relay call checks before describing the app as fully working.
6. Connect the existing domain using Render's custom-domain instructions and
   the existing DNS provider. Render Free supports custom domains and HTTPS.

Free-tier limits are real: Render sleeps after 15 minutes idle and can take about
a minute to wake. Its local filesystem is temporary, so do not use local JSON or
local uploads for a deployed account. Supabase Free includes 500 MB of database
storage, 1 GB of files, and 5 GB of origin egress; it may pause after a week of
inactivity and restrict usage beyond its allowance. Save encrypted backups outside
the database. Render's own free database expires after 30 days, so it is not used.
Calls can stop if a free host restarts, and free tiers provide no uptime guarantee.

Current provider references: [Render Free](https://render.com/docs/free),
[Supabase pricing](https://supabase.com/pricing),
[Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres),
[Supabase S3](https://supabase.com/docs/guides/storage/s3/authentication).

## Other hosting options

Recommended hosted stack:

- Domain/DNS: Cloudflare DNS.
- App hosting: Render Web Service.
- Database: PostgreSQL.
- Encrypted media: private Cloudflare R2 bucket through the S3-compatible API.
- HTTPS: Render custom domain TLS, or Caddy if self-hosting.

Before deployment, run `npm run check` and `npm test`. The app requires Node `>=24.7` unless the deployment also provides a compatible Argon2 package fallback.

## Render + PostgreSQL + R2

1. Push this project to a private GitHub repository.
2. In Render, create a web service and configure an external PostgreSQL database.
   The default `render.yaml` now creates only a Free web service; paid hosting and
   a paid database must be selected separately and require a budget.
3. Create a private Cloudflare R2 bucket.
4. Create R2 S3 API credentials with access only to that bucket.
5. Set these Render environment variables:

```text
PUBLIC_ORIGIN=https://your-domain.example
APP_SETUP_CODE=<long random setup code>
CSP_REPORT_URI=/api/csp-report
NODE_ENV=production
STORE_DRIVER=postgres
MEDIA_DRIVER=s3
S3_BUCKET=<private bucket name>
S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<r2 access key>
S3_SECRET_ACCESS_KEY=<r2 secret key>
BACKUP_PASSPHRASE=<long random backup secret>
```

6. Add your custom domain to Render.
7. Point DNS to Render as instructed by Render.
8. Open the site, enter `APP_SETUP_CODE`, create your account, then create one invite.

Production must serve only HTTPS. Confirm response headers include HSTS, strict CSP, `HttpOnly`/`Secure` session cookies, and no unexpected external script/style origins. If SRI hashes are introduced later, regenerate them whenever `public/app.js` or `public/styles.css` changes.

## Self-Hosted HTTPS

Use `deploy/docker-compose.production.yml` with a VPS that has ports 80 and 443 open.

```powershell
$env:DOMAIN="chat.your-domain.example"
$env:POSTGRES_PASSWORD="<long random postgres password>"
docker compose -f deploy/docker-compose.production.yml up -d --build
```

Caddy will request and renew HTTPS certificates automatically for `$DOMAIN`.

## Backups

Set `BACKUP_PASSPHRASE` before running backups.

```powershell
npm run backup
```

For PostgreSQL production, install `pg_dump` on the host that runs the backup command. The backup output is encrypted before it is written to disk. If `BACKUP_S3_BUCKET` is set, the encrypted backup file is also uploaded to S3/R2.

## Restore

```powershell
npm run restore -- backups/<file>.cwmbackup
```

JSON/local restores are written back directly. PostgreSQL restores write `backups/restore.pgcustom`; then run the printed `pg_restore` command against your production database.

## Migration From Local MVP

After adding production `DATABASE_URL`:

```powershell
$env:STORE_DRIVER="postgres"
npm run migrate:postgres
```

After adding production R2/S3 credentials:

```powershell
$env:MEDIA_DRIVER="s3"
npm run migrate:media
```

When both migrations are complete, deploy with `STORE_DRIVER=postgres` and `MEDIA_DRIVER=s3`.
# Voice and video calls

Use one running app instance: call state and Socket.IO presence are in memory.
Deploying or restarting the app ends active calls. No database migration is needed
for calling. A domain registration or GoDaddy Website Builder page alone does not
run this Node application; connect the domain to the actual Render service or VPS.

Production requires HTTPS, `PUBLIC_ORIGIN` set to the exact origin (for this app,
`https://chatwithme.space`), and an authenticated TURN relay. Calling deliberately
returns an actionable setup error in production until relay credentials exist.
Development can use STUN alone for local checks, which does not prove connectivity
across different networks.

Choose one relay configuration in the hosting service's environment settings:

- Metered OpenRelay: set `METERED_TURN_APP_NAME` (only the app name, not a URL)
  and `METERED_TURN_API_KEY`. The authenticated backend fetches the provider's
  ICE-server array; the master API key stays server-side. Credentials use the
  provider's expiry rules; this integration does not create its own two-hour
  Metered credentials. The [OpenRelay page](https://www.metered.ca/tools/openrelay/)
  advertises 20 GB/month free, while the separate premium TURN offer has different
  terms. Verify the actual account's free entitlement, zero balance, no card, and
  no automatic recharge before activation. If it requires payment, stop and choose
  another free relay. Exhausted/unavailable relay service reports an error instead
  of pretending a STUN-only call is reliable. The default Blueprint has these fields.
- Cloudflare Realtime TURN: set `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`. The backend
  exchanges these for two-hour temporary browser credentials. The API token is never
  sent to the browser. This provider bills beyond its free allowance, so do not
  enable it for a strict zero-cost deployment without a confirmed hard usage cap.
- coturn: set `TURN_URLS` (comma-separated TURN/TURNS URLs) and `TURN_SHARED_SECRET`
  matching your relay's `use-auth-secret` configuration. The backend signs temporary
  credentials. If using this option, replace the two Cloudflare TURN fields in the
  Blueprint with these environment keys before creating the service.

Relay configuration: [Cloudflare credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
and [WebRTC TURN guide](https://webrtc.org/getting-started/turn-server).

The authenticated `/api/calls/config` response is `Cache-Control: no-store`.
Call signaling is sent only between accepted devices and is not stored with messages.
Media uses WebRTC's encryption; it is not encrypted with the shared message phrase.
Direct connections may reveal network addresses to the other participant. Set
`RTC_RELAY_ONLY=true` to require relayed media. Calls require both people to keep the
chat open; background or closed mobile browsers cannot reliably receive calls.

Before a production release, run `npm run check` and `npm test`, then test voice and
video using two signed-in devices on separate networks. Set `RTC_RELAY_ONLY=true`
during that check and verify the selected ICE candidate pair is relayed. Confirm
media in both directions, mute/camera controls, decline, missed calls, remote hang-up,
permission denial, and successful calls after a prior call has ended. Also verify
existing encrypted messaging, database access and media uploads.

Optional local browser regression: install Playwright in the development environment
(`npm install --no-save playwright`, then `npx playwright install chromium`) and run
`npm run test:calls:browser`. Alternatively, `CALL_TEST_PLAYWRIGHT` can point to an
existing Playwright module and `CALL_TEST_BROWSER` to a compatible browser executable.
The script starts an isolated app copy in a temporary directory (or `CALL_TEST_WORKDIR`), creates synthetic test
accounts there, and uses two separate browsers with fake media devices. It verifies
voice/video media reception, controls, decline, cleanup after a delayed media response,
and server-side logout. It does not contact or change the production app or prove TURN
connectivity. No production credentials or real user records are needed.

For a scheduled release, select a tested commit and deploy that exact revision through
the configured host at the agreed time. Disable automatic production deploys while
preparing a scheduled release, to avoid publishing the feature branch early. Verify
host deployment completion and the actual domain afterward; a deploy-hook response
or `/api/health` alone does not verify storage or calls. Keep the previous release
available for rollback.
