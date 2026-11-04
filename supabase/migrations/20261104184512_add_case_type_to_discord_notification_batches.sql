-- Keep the notification batch type constraint aligned with the API's supported record types.
-- The application already accepts and sends "case" notifications; this migration
-- makes the database audit table accept the same record family.
ALTER TABLE public.discord_notification_batches
  DROP CONSTRAINT IF EXISTS discord_notification_batches_entity_type_check;

ALTER TABLE public.discord_notification_batches
  ADD CONSTRAINT discord_notification_batches_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'person'::text,
    'case'::text,
    'operation'::text,
    'report'::text,
    'investigation'::text,
    'task'::text,
    'announcement'::text
  ]));

COMMENT ON CONSTRAINT discord_notification_batches_entity_type_check
ON public.discord_notification_batches IS
'Allowed record families for manually initiated Discord notification batches.';
