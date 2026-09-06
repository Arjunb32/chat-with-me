# Items Kept For Your Approval Or Assistance

These are no longer code blockers. The app now has production-ready paths for them, but these items still need your actual accounts, credentials, or purchases before internet launch.

- Connect the existing `chatwithme.space` domain to the chosen app host.
- Create a Render account/project, or give VPS access for the Docker + Caddy path.
- Create a private Cloudflare R2 bucket or S3-compatible bucket.
- Add real production values for `PUBLIC_ORIGIN`, `APP_SETUP_CODE`, `DATABASE_URL`, and `S3_*`.
- Configure a TURN relay using `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`, or `TURN_URLS` + `TURN_SHARED_SECRET`.
- Verify voice and video calls across separate networks before the scheduled release.
- Choose backup schedule: daily is recommended for this private app.
- Add a production backup destination with `BACKUP_S3_BUCKET`.
- Keep recovery codes somewhere private after account creation or rotation.
