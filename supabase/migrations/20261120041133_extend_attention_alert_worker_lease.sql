create or replace function public.claim_attention_alert_worker(p_instance_id uuid)
returns boolean
language plpgsql
set search_path to 'public'
as $function$
declare
  current_instance uuid;
  current_expiry timestamptz;
begin
  insert into public.attention_alert_worker_lease (singleton, worker_instance_id, lease_expires_at)
  values (true, p_instance_id, now() + interval '60 seconds')
  on conflict (singleton) do nothing;

  select worker_instance_id, lease_expires_at
    into current_instance, current_expiry
    from public.attention_alert_worker_lease
   where singleton = true
   for update;

  if current_instance is null or current_expiry <= now() or current_instance = p_instance_id then
    update public.attention_alert_worker_lease
       set worker_instance_id = p_instance_id,
           lease_expires_at = now() + interval '60 seconds'
     where singleton = true;
    return true;
  end if;
  return false;
end;
$function$;

create or replace function public.renew_attention_alert_worker(p_instance_id uuid)
returns boolean
language plpgsql
set search_path to 'public'
as $function$
begin
  update public.attention_alert_worker_lease
     set lease_expires_at = now() + interval '60 seconds'
   where singleton = true
     and worker_instance_id = p_instance_id
     and lease_expires_at > now();
  return found;
end;
$function$;
