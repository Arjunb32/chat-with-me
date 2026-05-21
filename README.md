# Chat With Me

Private two-person chat website with secure login, invite-only signup, browser-side encryption, real-time text messages, encrypted photo upload, and encrypted voice messages.

## Run Locally

```powershell
npm install
npm run dev
```

Open `http://localhost:5177`.

The real local `.env` is already present and includes `APP_SETUP_CODE`. If the first account has not been created yet, enter that setup code on the first-account screen.

## First Setup

1. Create the first account.
2. Unlock the chat with a strong private encryption phrase.
3. Save the recovery codes shown after account creation.
4. Create one invite code from the app.
5. Share the invite code and the encryption phrase with your girlfriend outside this app.

The encryption phrase is never sent to the server. If it is lost, old encrypted messages and media cannot be decrypted.

## Production

See `DEPLOYMENT.md`.

Production support now includes:

- PostgreSQL with `STORE_DRIVER=postgres`.
- S3-compatible encrypted media storage with `MEDIA_DRIVER=s3`.
- Render Blueprint deployment through `render.yaml`.
- Docker + Caddy HTTPS deployment through `deploy/docker-compose.production.yml`.
- Encrypted backups with `npm run backup`.
- JSON-to-PostgreSQL migration with `npm run migrate:postgres`.
- Local-media-to-S3 migration with `npm run migrate:media`.
