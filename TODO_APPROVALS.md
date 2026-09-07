# Items Kept For Your Approval Or Assistance

The user requires a zero-cost deployment. Do not create paid services, add payment
details, or treat a billable free allowance as a spending cap. These items still
need actual free accounts and configuration before the app is fully usable online.

- Connect the existing `chatwithme.space` domain to the chosen app host.
- Finish the Render Free web service (account access is available).
- Sign in to Supabase and create a Free database plus private Storage bucket;
  disable its Data API because the app handles authentication itself.
- Add real production values for `PUBLIC_ORIGIN`, `APP_SETUP_CODE`, `DATABASE_URL`, and `S3_*`.
- Configure a verified free TURN relay with no automatic charges; keep provider
  credentials only in the server environment.
- Verify voice and video calls across separate networks before the scheduled release.
- Choose backup schedule: daily is recommended for this private app.
- Add a production backup destination with `BACKUP_S3_BUCKET`.
- Keep recovery codes somewhere private after account creation or rotation.
