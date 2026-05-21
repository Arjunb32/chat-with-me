# Production Deployment

Recommended hosted stack:

- Domain/DNS: Cloudflare DNS.
- App hosting: Render Web Service.
- Database: PostgreSQL.
- Encrypted media: private Cloudflare R2 bucket through the S3-compatible API.
- HTTPS: Render custom domain TLS, or Caddy if self-hosting.

## Render + PostgreSQL + R2

1. Push this project to a private GitHub repository.
2. In Render, create a Blueprint from `render.yaml`.
3. Create a private Cloudflare R2 bucket.
4. Create R2 S3 API credentials with access only to that bucket.
5. Set these Render environment variables:

```text
PUBLIC_ORIGIN=https://your-domain.example
APP_SETUP_CODE=<long random setup code>
S3_BUCKET=<private bucket name>
S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<r2 access key>
S3_SECRET_ACCESS_KEY=<r2 secret key>
BACKUP_PASSPHRASE=<long random backup secret>
```

6. Add your custom domain to Render.
7. Point DNS to Render as instructed by Render.
8. Open the site, enter `APP_SETUP_CODE`, create your account, then create one invite.

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
