-- Route the minute-level expiry worker through the existing Warnings function.
SELECT cron.schedule(
  'swat-warning-role-expiry',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url := 'https://swat-redline.vercel.app/api/warnings?task=expire',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
            FROM vault.decrypted_secrets
           WHERE name = 'swat_warning_expiry_cron_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    ) AS request_id;
  $job$
);
