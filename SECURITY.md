# Security Notes

This project is designed for a private two-person chat, not public registration.

## Implemented

- Invite-only signup after the first owner account.
- Maximum two accounts by default.
- Passwords are hashed with bcrypt.
- Login, setup, upload, and API routes are rate limited.
- Sessions use random tokens stored as hashes server-side.
- Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production.
- Verified-device cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production.
- New-device logins can require one-time recovery codes.
- Message text, photo bytes, and voice bytes are encrypted in the browser before reaching the server.
- Attachments are stored outside the public web root and require authentication to fetch.
- Production media can be stored in private S3/R2 object storage.
- Production metadata can be stored in PostgreSQL.
- Backups are encrypted with AES-256-GCM before being written to disk or uploaded.
- Strict security headers are set with Helmet.
- Upload size is limited.
- Disappearing message expiration is supported.

## Important Tradeoffs

Because media is encrypted before upload, the server cannot inspect the original photo or voice file type. The browser validates type and size before encryption; this is acceptable for a trusted two-person app, but a public service would need a different safety model.

Local development still uses JSON plus local encrypted attachment files by default. Production should set `STORE_DRIVER=postgres` and `MEDIA_DRIVER=s3`.

## Approval Or Assistance Needed Later

- Domain name purchase and DNS setup.
- Render account/custom-domain connection, or VPS access if self-hosting.
- Production PostgreSQL credentials if not using the Render Blueprint database.
- Private R2/S3 bucket credentials.
- Backup destination and schedule.
