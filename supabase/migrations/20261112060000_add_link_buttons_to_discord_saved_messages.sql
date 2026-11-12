-- Store Discord link buttons alongside each reusable saved message.
alter table public.discord_saved_messages
  add column if not exists link_buttons jsonb not null default '[]'::jsonb;

alter table public.discord_saved_messages
  drop constraint if exists discord_saved_messages_link_buttons_check;

alter table public.discord_saved_messages
  add constraint discord_saved_messages_link_buttons_check
  check (
    jsonb_typeof(link_buttons) = 'array'
    and jsonb_array_length(link_buttons) <= 25
  );
