-- Register the one-minute poller for the deployed Vercel attendance route.
-- Apply this migration only after /api/attendance/sync is live in production.
SELECT cron.schedule(
  'swat-daily-attendance-poller',
  '* * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://swat-redline.vercel.app/api/attendance/sync',
      headers := jsonb_build_object(
        'x-announcement-sync-secret',
        (SELECT decrypted_secret
           FROM vault.decrypted_secrets
          WHERE name = 'swat_announcement_sync_secret')
      ),
      timeout_milliseconds := 15000
    ) AS request_id;
  $job$
);
