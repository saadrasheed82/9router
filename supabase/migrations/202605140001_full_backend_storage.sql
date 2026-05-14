create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.owns_device(target_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.devices d
    where d.id = target_device_id
      and d.user_id = auth.uid()
      and d.is_active = true
      and d.deleted_at is null
  );
$$;

revoke execute on function public.owns_device(uuid) from public;
grant execute on function public.owns_device(uuid) to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  machine_id text not null,
  name text,
  is_active boolean not null default true,
  encryption_key_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  deleted_at timestamptz,
  unique(user_id, machine_id)
);

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id)
);

create table public.provider_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  type text,
  name text,
  prefix text,
  api_type text,
  base_url text,
  extra_data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  provider text not null,
  auth_type text not null,
  name text,
  email text,
  priority integer,
  is_active boolean not null default true,
  test_status text,
  last_error text,
  rate_limited_until timestamptz,
  provider_specific_data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.provider_secret_blobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  connection_id uuid not null references public.provider_connections(id) on delete cascade,
  encrypted_payload text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(connection_id, device_id)
);

create table public.proxy_pools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  is_active boolean not null default true,
  test_status text,
  proxy_type text,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.proxy_pool_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  proxy_pool_id uuid not null references public.proxy_pools(id) on delete cascade,
  encrypted_payload text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(proxy_pool_id, device_id)
);

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  key text not null unique,
  name text,
  machine_id text,
  is_active boolean not null default true,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.api_key_secret_blobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  key_id uuid not null references public.api_keys(id) on delete cascade,
  encrypted_payload text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(key_id, device_id)
);

create table public.model_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alias text not null,
  target_model text not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id, alias)
);

create table public.custom_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  provider_alias text not null,
  model_id text not null,
  type text not null default 'llm',
  extra_data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id, provider_alias, model_id, type)
);

create table public.combos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text,
  models jsonb not null default '[]'::jsonb,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id, name)
);

create table public.pricing_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  model text not null,
  input numeric,
  output numeric,
  cached numeric,
  reasoning numeric,
  cache_creation numeric,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(user_id, provider, model)
);

create table public.usage_events (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  timestamp timestamptz not null default now(),
  provider text,
  model text,
  connection_id uuid references public.provider_connections(id) on delete set null,
  api_key text,
  endpoint text,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  cost numeric not null default 0,
  status text,
  tokens jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);

create table public.usage_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  date_key text not null,
  requests bigint not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  cost numeric not null default 0,
  by_provider jsonb not null default '{}'::jsonb,
  by_model jsonb not null default '{}'::jsonb,
  by_account jsonb not null default '{}'::jsonb,
  by_api_key jsonb not null default '{}'::jsonb,
  by_endpoint jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(user_id, device_id, date_key)
);

create table public.request_details (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  timestamp timestamptz not null default now(),
  provider text,
  model text,
  connection_id uuid references public.provider_connections(id) on delete set null,
  status text,
  data jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);

create table public.sync_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  table_name text not null,
  record_id uuid,
  event_type text not null check (event_type in ('INSERT', 'UPDATE', 'DELETE')),
  version bigint not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index devices_user_idx on public.devices(user_id);
create index provider_nodes_user_type_idx on public.provider_nodes(user_id, type);
create index provider_connections_user_provider_idx on public.provider_connections(user_id, provider);
create index provider_connections_user_provider_active_idx on public.provider_connections(user_id, provider, is_active);
create index provider_secret_blobs_user_device_idx on public.provider_secret_blobs(user_id, device_id);
create index proxy_pools_user_device_idx on public.proxy_pools(user_id, device_id);
create index api_keys_user_device_idx on public.api_keys(user_id, device_id);
create index combos_user_name_idx on public.combos(user_id, name);
create index pricing_user_provider_model_idx on public.pricing_overrides(user_id, provider, model);
create index usage_events_user_ts_idx on public.usage_events(user_id, timestamp desc);
create index usage_events_device_ts_idx on public.usage_events(device_id, timestamp desc);
create index usage_events_user_provider_idx on public.usage_events(user_id, provider);
create index usage_events_user_model_idx on public.usage_events(user_id, model);
create index usage_daily_user_device_date_idx on public.usage_daily(user_id, device_id, date_key);
create index request_details_user_device_ts_idx on public.request_details(user_id, device_id, timestamp desc);
create index sync_events_user_device_table_version_idx on public.sync_events(user_id, device_id, table_name, version desc);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger devices_updated_at before update on public.devices for each row execute function public.set_updated_at();
create trigger settings_updated_at before update on public.settings for each row execute function public.set_updated_at();
create trigger provider_nodes_updated_at before update on public.provider_nodes for each row execute function public.set_updated_at();
create trigger provider_connections_updated_at before update on public.provider_connections for each row execute function public.set_updated_at();
create trigger provider_secret_blobs_updated_at before update on public.provider_secret_blobs for each row execute function public.set_updated_at();
create trigger proxy_pools_updated_at before update on public.proxy_pools for each row execute function public.set_updated_at();
create trigger proxy_pool_secrets_updated_at before update on public.proxy_pool_secrets for each row execute function public.set_updated_at();
create trigger api_keys_updated_at before update on public.api_keys for each row execute function public.set_updated_at();
create trigger api_key_secret_blobs_updated_at before update on public.api_key_secret_blobs for each row execute function public.set_updated_at();
create trigger model_aliases_updated_at before update on public.model_aliases for each row execute function public.set_updated_at();
create trigger custom_models_updated_at before update on public.custom_models for each row execute function public.set_updated_at();
create trigger combos_updated_at before update on public.combos for each row execute function public.set_updated_at();
create trigger pricing_overrides_updated_at before update on public.pricing_overrides for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.settings enable row level security;
alter table public.provider_nodes enable row level security;
alter table public.provider_connections enable row level security;
alter table public.provider_secret_blobs enable row level security;
alter table public.proxy_pools enable row level security;
alter table public.proxy_pool_secrets enable row level security;
alter table public.api_keys enable row level security;
alter table public.api_key_secret_blobs enable row level security;
alter table public.model_aliases enable row level security;
alter table public.custom_models enable row level security;
alter table public.combos enable row level security;
alter table public.pricing_overrides enable row level security;
alter table public.usage_events enable row level security;
alter table public.usage_daily enable row level security;
alter table public.request_details enable row level security;
alter table public.sync_events enable row level security;

create policy profiles_own_all on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy devices_own_all on public.devices for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy settings_own_all on public.settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy provider_nodes_own_all on public.provider_nodes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy provider_connections_own_all on public.provider_connections for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy proxy_pools_own_all on public.proxy_pools for all using (user_id = auth.uid() and (device_id is null or public.owns_device(device_id))) with check (user_id = auth.uid() and (device_id is null or public.owns_device(device_id)));
create policy api_keys_own_all on public.api_keys for all using (user_id = auth.uid() and (device_id is null or public.owns_device(device_id))) with check (user_id = auth.uid() and (device_id is null or public.owns_device(device_id)));
create policy model_aliases_own_all on public.model_aliases for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy custom_models_own_all on public.custom_models for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy combos_own_all on public.combos for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy pricing_overrides_own_all on public.pricing_overrides for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy usage_events_own_all on public.usage_events for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy usage_daily_own_all on public.usage_daily for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy request_details_own_all on public.request_details for all using (user_id = auth.uid() and public.owns_device(device_id)) with check (user_id = auth.uid() and public.owns_device(device_id));
create policy sync_events_own_all on public.sync_events for all using (user_id = auth.uid() and public.owns_device(device_id)) with check (user_id = auth.uid() and public.owns_device(device_id));
create policy provider_secret_blobs_own_device_all on public.provider_secret_blobs for all using (user_id = auth.uid() and public.owns_device(device_id)) with check (user_id = auth.uid() and public.owns_device(device_id));
create policy proxy_pool_secrets_own_device_all on public.proxy_pool_secrets for all using (user_id = auth.uid() and public.owns_device(device_id)) with check (user_id = auth.uid() and public.owns_device(device_id));
create policy api_key_secret_blobs_own_device_all on public.api_key_secret_blobs for all using (user_id = auth.uid() and public.owns_device(device_id)) with check (user_id = auth.uid() and public.owns_device(device_id));

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('exports', 'exports', false, 52428800),
  ('request-artifacts', 'request-artifacts', false, 52428800),
  ('avatars', 'avatars', false, 5242880)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

create policy storage_exports_own_paths on storage.objects
for all
to authenticated
using (
  bucket_id in ('exports', 'request-artifacts', 'avatars')
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id in ('exports', 'request-artifacts', 'avatars')
  and (storage.foldername(name))[1] = auth.uid()::text
);

alter publication supabase_realtime add table public.settings;
alter publication supabase_realtime add table public.provider_nodes;
alter publication supabase_realtime add table public.provider_connections;
alter publication supabase_realtime add table public.model_aliases;
alter publication supabase_realtime add table public.custom_models;
alter publication supabase_realtime add table public.combos;
alter publication supabase_realtime add table public.pricing_overrides;
alter publication supabase_realtime add table public.usage_events;
alter publication supabase_realtime add table public.usage_daily;
alter publication supabase_realtime add table public.request_details;
alter publication supabase_realtime add table public.sync_events;
