-- Register the one-minute poller through the existing notifications serverless function.
-- Apply this migration only after the updated function is deployed to production.
SELECT cron.schedule(
  'swat-daily-attendance-poller',
  '* * * * *',
  $job$
    SELECT net.http_get(
      url := 'https://swat-redline.vercel.app/api/notifications/send?task=attendance',
      headers := jsonb_build_object(
        'x-announcement-sync-secret',
        (SELECT decrypted_secret
           FROM vault.decrypted_secrets
          WHERE name = 'swat_announcement_sync_secret')
      ),
      timeout_milliseconds := 55000
    ) AS request_id;
  $job$
);
