create table if not exists public.resignation_requests (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null references public.staff_profiles(discord_user_id) on delete cascade,
  display_name text not null,
  member_name text not null,
  reason text not null,
  status text not null default 'pending',
  source text not null default 'website',
  avatar_url text,
  discord_channel_id text,
  discord_message_id text,
  discord_interaction_id text,
  discord_message_url text,
  submitted_at timestamptz not null default now(),
  reviewed_by_discord_id text,
  reviewed_by_name text,
  review_note text,
  reviewed_at timestamptz,
  dm_status text not null default 'not_sent',
  dm_error text,
  dm_channel_id text,
  dm_message_id text,
  admin_alert_queued_at timestamptz,
  publication_channel_id text,
  publication_message_id text,
  published_at timestamptz,
  publish_status text not null default 'not_published',
  publish_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resignation_requests_member_name_length check (char_length(btrim(member_name)) between 2 and 100),
  constraint resignation_requests_reason_length check (char_length(btrim(reason)) between 3 and 2000),
  constraint resignation_requests_status_check check (status in ('pending','approved','rejected')),
  constraint resignation_requests_source_check check (source in ('website','discord')),
  constraint resignation_requests_discord_user_id_check check (discord_user_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_discord_channel_id_check check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_discord_message_id_check check (discord_message_id is null or discord_message_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_discord_interaction_id_check check (discord_interaction_id is null or discord_interaction_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_publication_channel_id_check check (publication_channel_id is null or publication_channel_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_publication_message_id_check check (publication_message_id is null or publication_message_id ~ '^[0-9]{15,22}$'),
  constraint resignation_requests_dm_status_check check (dm_status in ('not_sent','sent','failed','skipped')),
  constraint resignation_requests_publish_status_check check (publish_status in ('not_published','published','failed'))
);
create unique index if not exists resignation_requests_discord_interaction_unique on public.resignation_requests (discord_interaction_id) where discord_interaction_id is not null;
create unique index if not exists resignation_requests_one_pending_per_member on public.resignation_requests (discord_user_id) where status = 'pending';
create index if not exists resignation_requests_member_created_idx on public.resignation_requests (discord_user_id, created_at desc);
create index if not exists resignation_requests_status_created_idx on public.resignation_requests (status, created_at desc);
create index if not exists resignation_requests_pending_alert_idx on public.resignation_requests (created_at asc) where status = 'pending' and admin_alert_queued_at is null;
create index if not exists resignation_requests_pending_publication_idx on public.resignation_requests (reviewed_at desc) where status = 'approved' and publish_status <> 'published';
alter table public.resignation_requests enable row level security;
revoke all on table public.resignation_requests from public, anon, authenticated;
grant select, insert, update on table public.resignation_requests to service_role;
alter table public.attendance_admin_alerts drop constraint if exists attendance_admin_alerts_alert_type_check;
alter table public.attendance_admin_alerts add constraint attendance_admin_alerts_alert_type_check
  check (alert_type = any (array['leave_request'::text, 'resignation_request'::text, 'warning_due'::text, 'voice_missing'::text]));
