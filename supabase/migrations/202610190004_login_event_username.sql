-- Store Discord's actual username separately from the display name in login events.
alter table public.staff_login_events
  add column if not exists username text;

notify pgrst, 'reload schema';
