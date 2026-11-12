-- Allow saved Discord messages without an explicit title.
alter table public.discord_saved_messages
  alter column title drop not null;

alter table public.discord_saved_messages
  drop constraint if exists discord_saved_messages_title_check;

alter table public.discord_saved_messages
  add constraint discord_saved_messages_title_check
  check (char_length(btrim(coalesce(title, ''))) <= 256);
