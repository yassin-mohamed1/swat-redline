ALTER TABLE public.discord_notification_batches
  DROP CONSTRAINT IF EXISTS discord_notification_batches_entity_type_check;

ALTER TABLE public.discord_notification_batches
  ADD CONSTRAINT discord_notification_batches_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'person'::text,
    'operation'::text,
    'report'::text,
    'investigation'::text,
    'task'::text
  ]));
