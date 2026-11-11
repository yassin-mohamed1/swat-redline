-- Saved Discord messages are stored as metadata in Postgres and full text in a private Storage bucket.
create table if not exists public.discord_saved_messages (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 256),
  storage_path text not null unique check (storage_path ~ '^messages/[0-9a-f-]{36}\\.txt$'),
  content_preview text not null default '',
  content_chars bigint not null default 0 check (content_chars >= 0),
  content_bytes bigint not null default 0 check (content_bytes >= 0),
  created_by_discord_id text not null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_sent_channel_id text,
  last_sent_message_id text,
  send_count bigint not null default 0 check (send_count >= 0)
);

create index if not exists discord_saved_messages_created_at_idx
  on public.discord_saved_messages (created_at desc);

alter table public.discord_saved_messages enable row level security;
revoke all on table public.discord_saved_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.discord_saved_messages to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('swat-discord-messages', 'swat-discord-messages', false, null, null)
on conflict (id) do update set public = false;
