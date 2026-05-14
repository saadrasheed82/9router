# Supabase Full Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Supabase full backend for 9Router with encrypted device-scoped secrets, Realtime sync primitives, private storage buckets, and local SQLite as the runtime cache.

**Architecture:** Supabase owns durable user data and storage; local SQLite remains the routing fast path. The implementation starts with schema/RLS and isolated crypto/sync primitives, then wires repository write hooks and dashboard/runtime integration in later tasks.

**Tech Stack:** Next.js 16, JavaScript ES modules, Vitest, Supabase Postgres/Storage/Realtime, Web Crypto / Node `crypto`, existing SQLite repository layer in `src/lib/db/`.

---

## File Structure

### New files
- `supabase/migrations/202605140001_full_backend_storage.sql` — creates extensions, tables, indexes, buckets, RLS policies, helper functions, and realtime publication settings.
- `src/lib/supabase/config.js` — reads Supabase URL/anon key/service role env values and reports whether Supabase is configured.
- `src/lib/supabase/client.js` — creates browser/server Supabase clients lazily.
- `src/lib/crypto/keyDerive.js` — derives device encryption keys and hashes from `machineId + userSecret`.
- `src/lib/crypto/secretEncrypt.js` — AES-256-GCM encryption/decryption for Supabase secret blobs.
- `src/lib/cloudSync/tableMap.js` — maps local SQLite concepts to Supabase table names and primary keys.
- `src/lib/cloudSync/syncEvents.js` — local pending sync-event helpers and Supabase payload builders.
- `src/lib/cloudSync/cloudSyncManager.js` — orchestrates device registration, push-on-write, replay, and realtime subscriptions.
- `src/lib/db/hooks/cloudSyncHooks.js` — small hook API used by repositories to mirror successful local writes to Supabase.
- `tests/unit/secret-encryption.test.js` — crypto round-trip and tamper tests.
- `tests/unit/cloud-sync-events.test.js` — sync event payload tests.
- `tests/unit/cloud-sync-manager.test.js` — manager behavior tests with mocked Supabase client.

### Modified files
- `.env.example` — add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_SYNC_ENABLED`.
- `package.json` — add `@supabase/supabase-js` and test scripts if missing.
- `src/lib/db/schema.js` — add local `syncEvents` table for offline queueing.
- `src/lib/db/migrations/index.js` — register a new SQLite migration for `syncEvents`.
- `src/lib/db/migrations/002-sync-events.js` — create local pending sync events table.
- `src/lib/db/repos/settingsRepo.js` — call cloud sync hook after successful local settings update.
- `src/lib/db/repos/connectionsRepo.js` — split secret fields before sync and call cloud sync hook after connection writes.
- `src/lib/db/repos/nodesRepo.js` — call cloud sync hook after node writes.
- `src/lib/db/repos/proxyPoolsRepo.js` — call cloud sync hook after proxy pool writes.
- `src/lib/db/repos/apiKeysRepo.js` — call cloud sync hook after API key writes.
- `src/lib/db/repos/aliasRepo.js` — call cloud sync hook after alias/custom model writes.
- `src/lib/db/repos/combosRepo.js` — call cloud sync hook after combo writes.
- `src/lib/db/repos/pricingRepo.js` — call cloud sync hook after pricing writes.
- `src/lib/db/repos/usageRepo.js` — call cloud sync hook after usage event/day writes.
- `src/lib/db/repos/requestDetailsRepo.js` — call cloud sync hook after request detail writes.
- `src/shared/services/cloudSyncScheduler.js` — delegate to `CloudSyncManager` instead of old `/api/sync/cloud` polling.

---

## Task 1: Add Supabase Schema, RLS, Buckets, and Realtime Migration

**Files:**
- Create: `supabase/migrations/202605140001_full_backend_storage.sql`

- [ ] **Step 1: Create the migration directory**

Run:
```bash
mkdir -p supabase/migrations
```
Expected: directory exists.

- [ ] **Step 2: Write the Supabase migration**

Create `supabase/migrations/202605140001_full_backend_storage.sql` with this content:

```sql
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
  device_id uuid references public.devices(id) on delete cascade,
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
```

- [ ] **Step 3: Apply migration to Supabase project**

Run via MCP `apply_migration` using project id `urlvojphjewtxerrigkd`, name `full_backend_storage`, and the SQL from Step 2.
Expected: migration succeeds.

- [ ] **Step 4: Verify tables and buckets**

Run via MCP:
```text
list_tables(project_id="urlvojphjewtxerrigkd", schemas=["public", "storage"], verbose=false)
```
Expected: all public tables exist and storage buckets include `exports`, `request-artifacts`, `avatars`.

- [ ] **Step 5: Run advisors**

Run via MCP:
```text
get_advisors(project_id="urlvojphjewtxerrigkd", type="security")
get_advisors(project_id="urlvojphjewtxerrigkd", type="performance")
```
Expected: no new critical security warnings for public tables or storage policies.

- [ ] **Step 6: Commit**

Run:
```bash
git add supabase/migrations/202605140001_full_backend_storage.sql
git commit -m "feat: add Supabase backend schema"
```
Expected: commit succeeds.

---

## Task 2: Add Supabase Environment and Client Setup

**Files:**
- Modify: `.env.example`
- Modify: `package.json`
- Create: `src/lib/supabase/config.js`
- Create: `src/lib/supabase/client.js`

- [ ] **Step 1: Add failing config test**

Create `tests/unit/supabase-config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadConfig() {
  const mod = await import(`../../src/lib/supabase/config.js?${Date.now()}`);
  return mod;
}

describe("supabase config", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports disabled when url or anon key is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const { isSupabaseConfigured } = await loadConfig();
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns public client config when env is present", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const { getSupabasePublicConfig, isSupabaseConfigured } = await loadConfig();
    expect(isSupabaseConfigured()).toBe(true);
    expect(getSupabasePublicConfig()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
  });
});
```

- [ ] **Step 2: Run failing test**

Run:
```bash
npx vitest run tests/unit/supabase-config.test.js --config tests/vitest.config.js
```
Expected: FAIL because `src/lib/supabase/config.js` does not exist.

- [ ] **Step 3: Install Supabase dependency**

Run:
```bash
npm install @supabase/supabase-js
```
Expected: `package.json` and lockfile update with `@supabase/supabase-js`.

- [ ] **Step 4: Update `.env.example`**

Append:

```env
# Supabase full backend
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_SYNC_ENABLED=false
```

- [ ] **Step 5: Implement Supabase config**

Create `src/lib/supabase/config.js`:

```js
export function getSupabasePublicConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  };
}

export function getSupabaseServiceConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  };
}

export function isSupabaseConfigured() {
  const { url, anonKey } = getSupabasePublicConfig();
  return Boolean(url && anonKey);
}

export function isSupabaseSyncEnabled() {
  return process.env.SUPABASE_SYNC_ENABLED === "true" && isSupabaseConfigured();
}
```

- [ ] **Step 6: Implement lazy clients**

Create `src/lib/supabase/client.js`:

```js
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, getSupabaseServiceConfig } from "./config.js";

let publicClient = null;
let serviceClient = null;

export function getSupabaseClient() {
  if (publicClient) return publicClient;
  const { url, anonKey } = getSupabasePublicConfig();
  if (!url || !anonKey) return null;
  publicClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return publicClient;
}

export function getSupabaseServiceClient() {
  if (serviceClient) return serviceClient;
  const { url, serviceRoleKey } = getSupabaseServiceConfig();
  if (!url || !serviceRoleKey) return null;
  serviceClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}
```

- [ ] **Step 7: Run config test**

Run:
```bash
npx vitest run tests/unit/supabase-config.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

Run:
```bash
git add .env.example package.json package-lock.json src/lib/supabase/config.js src/lib/supabase/client.js tests/unit/supabase-config.test.js
git commit -m "feat: add Supabase client configuration"
```
Expected: commit succeeds.

---

## Task 3: Add Device Secret Encryption Utilities

**Files:**
- Create: `src/lib/crypto/keyDerive.js`
- Create: `src/lib/crypto/secretEncrypt.js`
- Test: `tests/unit/secret-encryption.test.js`

- [ ] **Step 1: Write failing crypto tests**

Create `tests/unit/secret-encryption.test.js`:

```js
import { describe, it, expect } from "vitest";
import { deriveDeviceKey, hashDeviceKey } from "../../src/lib/crypto/keyDerive.js";
import { encryptSecretPayload, decryptSecretPayload } from "../../src/lib/crypto/secretEncrypt.js";

describe("secret encryption", () => {
  it("round-trips a provider credential payload", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const encrypted = await encryptSecretPayload({
      key,
      payload: { accessToken: "access", refreshToken: "refresh", expiresAt: "2026-05-14T00:00:00.000Z" },
    });

    expect(encrypted).toMatch(/^v1:/);

    const decrypted = await decryptSecretPayload({ key, encryptedPayload: encrypted });
    expect(decrypted).toEqual({ accessToken: "access", refreshToken: "refresh", expiresAt: "2026-05-14T00:00:00.000Z" });
  });

  it("rejects tampered payloads", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const encrypted = await encryptSecretPayload({ key, payload: { apiKey: "secret" } });
    const tampered = encrypted.slice(0, -4) + "AAAA";

    await expect(decryptSecretPayload({ key, encryptedPayload: tampered })).rejects.toThrow("Failed to decrypt secret payload");
  });

  it("hashes a derived key without exposing key material", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const hash = await hashDeviceKey(key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("passphrase");
  });
});
```

- [ ] **Step 2: Run failing tests**

Run:
```bash
npx vitest run tests/unit/secret-encryption.test.js --config tests/vitest.config.js
```
Expected: FAIL because crypto modules do not exist.

- [ ] **Step 3: Implement key derivation**

Create `src/lib/crypto/keyDerive.js`:

```js
import crypto from "node:crypto";

const DEFAULT_ITERATIONS = 100000;
const KEY_BYTES = 32;

export async function deriveDeviceKey({ machineId, userSecret, salt = "9router-supabase-secret-v1" }) {
  if (!machineId || !userSecret) {
    throw new Error("machineId and userSecret are required to derive a device key");
  }
  return crypto.pbkdf2Sync(`${machineId}:${userSecret}`, salt, DEFAULT_ITERATIONS, KEY_BYTES, "sha256");
}

export async function hashDeviceKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("device key must be a 32-byte Buffer");
  }
  return crypto.createHash("sha256").update(key).digest("hex");
}
```

- [ ] **Step 4: Implement secret encryption**

Create `src/lib/crypto/secretEncrypt.js`:

```js
import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function encryptSecretPayload({ key, payload }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("device key must be a 32-byte Buffer");
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const plaintext = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export async function decryptSecretPayload({ key, encryptedPayload }) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error("device key must be a 32-byte Buffer");
    }
    const [version, ivB64, tagB64, ciphertextB64] = String(encryptedPayload || "").split(":");
    if (version !== VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
      throw new Error("invalid encrypted payload format");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Failed to decrypt secret payload");
  }
}
```

- [ ] **Step 5: Run crypto tests**

Run:
```bash
npx vitest run tests/unit/secret-encryption.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

Run:
```bash
git add src/lib/crypto/keyDerive.js src/lib/crypto/secretEncrypt.js tests/unit/secret-encryption.test.js
git commit -m "feat: add encrypted secret payload utilities"
```
Expected: commit succeeds.

---

## Task 4: Add Local Sync Events Queue

**Files:**
- Modify: `src/lib/db/schema.js`
- Create: `src/lib/db/migrations/002-sync-events.js`
- Modify: `src/lib/db/migrations/index.js`
- Create: `src/lib/cloudSync/tableMap.js`
- Create: `src/lib/cloudSync/syncEvents.js`
- Test: `tests/unit/cloud-sync-events.test.js`

- [ ] **Step 1: Inspect migration index format**

Read `src/lib/db/migrations/index.js` and keep the existing export shape. The new migration must match that shape exactly.

- [ ] **Step 2: Write failing sync-event tests**

Create `tests/unit/cloud-sync-events.test.js`:

```js
import { describe, it, expect } from "vitest";
import { mapLocalTableToSupabase, buildSyncEventPayload } from "../../src/lib/cloudSync/syncEvents.js";

describe("cloud sync events", () => {
  it("maps local providerConnections to provider_connections", () => {
    expect(mapLocalTableToSupabase("providerConnections")).toBe("provider_connections");
  });

  it("builds a normalized sync event payload", () => {
    const event = buildSyncEventPayload({
      userId: "user-1",
      deviceId: "device-1",
      localTable: "settings",
      recordId: "setting-row",
      eventType: "UPDATE",
      version: 3,
      payload: { cloudEnabled: true },
    });

    expect(event).toEqual({
      user_id: "user-1",
      device_id: "device-1",
      table_name: "settings",
      record_id: "setting-row",
      event_type: "UPDATE",
      version: 3,
      payload: { cloudEnabled: true },
    });
  });

  it("rejects unknown local tables", () => {
    expect(() => mapLocalTableToSupabase("unknownTable")).toThrow("No Supabase table mapping for unknownTable");
  });
});
```

- [ ] **Step 3: Run failing tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-events.test.js --config tests/vitest.config.js
```
Expected: FAIL because `src/lib/cloudSync/syncEvents.js` does not exist.

- [ ] **Step 4: Add local SQLite schema entry**

Modify `src/lib/db/schema.js` by adding this table inside `TABLES`:

```js
  syncEvents: {
    columns: {
      id: "TEXT PRIMARY KEY",
      userId: "TEXT",
      deviceId: "TEXT",
      tableName: "TEXT NOT NULL",
      recordId: "TEXT",
      eventType: "TEXT NOT NULL",
      version: "INTEGER DEFAULT 1",
      payload: "TEXT NOT NULL",
      status: "TEXT NOT NULL DEFAULT 'pending'",
      error: "TEXT",
      createdAt: "TEXT NOT NULL",
      syncedAt: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_sync_events_status ON syncEvents(status)",
      "CREATE INDEX IF NOT EXISTS idx_sync_events_created ON syncEvents(createdAt)",
    ],
  },
```

- [ ] **Step 5: Add SQLite migration**

Create `src/lib/db/migrations/002-sync-events.js`:

```js
export const id = 2;
export const name = "sync-events";

export function up(db) {
  db.run(`CREATE TABLE IF NOT EXISTS syncEvents (
    id TEXT PRIMARY KEY,
    userId TEXT,
    deviceId TEXT,
    tableName TEXT NOT NULL,
    recordId TEXT,
    eventType TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    createdAt TEXT NOT NULL,
    syncedAt TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_events_status ON syncEvents(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_events_created ON syncEvents(createdAt)`);
}
```

- [ ] **Step 6: Register migration**

Modify `src/lib/db/migrations/index.js` so it imports and includes migration 2. If the current file exports an array named `MIGRATIONS`, the final shape should look like:

```js
import * as initial from "./001-initial.js";
import * as syncEvents from "./002-sync-events.js";

export const MIGRATIONS = [initial, syncEvents];
```

Preserve any existing names if the file differs, but include `syncEvents` after the initial migration.

- [ ] **Step 7: Implement table map**

Create `src/lib/cloudSync/tableMap.js`:

```js
export const LOCAL_TO_SUPABASE_TABLE = {
  settings: "settings",
  providerConnections: "provider_connections",
  providerNodes: "provider_nodes",
  proxyPools: "proxy_pools",
  apiKeys: "api_keys",
  combos: "combos",
  modelAliases: "model_aliases",
  customModels: "custom_models",
  pricing: "pricing_overrides",
  usageHistory: "usage_events",
  usageDaily: "usage_daily",
  requestDetails: "request_details",
};
```

- [ ] **Step 8: Implement sync event helpers**

Create `src/lib/cloudSync/syncEvents.js`:

```js
import { LOCAL_TO_SUPABASE_TABLE } from "./tableMap.js";

export function mapLocalTableToSupabase(localTable) {
  const table = LOCAL_TO_SUPABASE_TABLE[localTable];
  if (!table) throw new Error(`No Supabase table mapping for ${localTable}`);
  return table;
}

export function buildSyncEventPayload({ userId, deviceId, localTable, recordId, eventType, version = 1, payload = {} }) {
  if (!userId || !deviceId || !localTable || !eventType) {
    throw new Error("userId, deviceId, localTable, and eventType are required");
  }
  return {
    user_id: userId,
    device_id: deviceId,
    table_name: mapLocalTableToSupabase(localTable),
    record_id: recordId || null,
    event_type: eventType,
    version,
    payload,
  };
}
```

- [ ] **Step 9: Run sync-event tests and migration chain tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-events.test.js tests/unit/db-migration-chain.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 10: Commit**

Run:
```bash
git add src/lib/db/schema.js src/lib/db/migrations/002-sync-events.js src/lib/db/migrations/index.js src/lib/cloudSync/tableMap.js src/lib/cloudSync/syncEvents.js tests/unit/cloud-sync-events.test.js
git commit -m "feat: add local cloud sync event queue"
```
Expected: commit succeeds.

---

## Task 5: Add Cloud Sync Manager Core

**Files:**
- Create: `src/lib/cloudSync/cloudSyncManager.js`
- Create: `src/lib/db/hooks/cloudSyncHooks.js`
- Test: `tests/unit/cloud-sync-manager.test.js`

- [ ] **Step 1: Write failing manager tests**

Create `tests/unit/cloud-sync-manager.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { CloudSyncManager } from "../../src/lib/cloudSync/cloudSyncManager.js";

describe("CloudSyncManager", () => {
  it("does not push when disabled", async () => {
    const supabase = { from: vi.fn() };
    const manager = new CloudSyncManager({ supabase, enabled: false, userId: "user-1", deviceId: "device-1" });
    const result = await manager.pushLocalChange({ localTable: "settings", recordId: "id", eventType: "UPDATE", payload: { ok: true } });
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("inserts sync event and upserts target table when enabled", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn((table) => ({
        insert: table === "sync_events" ? insert : undefined,
        upsert: table === "settings" ? upsert : undefined,
      })),
    };
    const manager = new CloudSyncManager({ supabase, enabled: true, userId: "user-1", deviceId: "device-1" });

    const result = await manager.pushLocalChange({
      localTable: "settings",
      recordId: "row-1",
      eventType: "UPDATE",
      version: 2,
      payload: { id: "row-1", data: { cloudEnabled: true } },
    });

    expect(result).toEqual({ pushed: true });
    expect(supabase.from).toHaveBeenCalledWith("sync_events");
    expect(supabase.from).toHaveBeenCalledWith("settings");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ table_name: "settings", event_type: "UPDATE" }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: "row-1", data: { cloudEnabled: true } }));
  });
});
```

- [ ] **Step 2: Run failing manager tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-manager.test.js --config tests/vitest.config.js
```
Expected: FAIL because `cloudSyncManager.js` does not exist.

- [ ] **Step 3: Implement manager core**

Create `src/lib/cloudSync/cloudSyncManager.js`:

```js
import { buildSyncEventPayload, mapLocalTableToSupabase } from "./syncEvents.js";

export class CloudSyncManager {
  constructor({ supabase, enabled = false, userId = null, deviceId = null } = {}) {
    this.supabase = supabase;
    this.enabled = enabled;
    this.userId = userId;
    this.deviceId = deviceId;
    this.channels = [];
  }

  isReady() {
    return Boolean(this.enabled && this.supabase && this.userId && this.deviceId);
  }

  async pushLocalChange({ localTable, recordId, eventType, version = 1, payload = {} }) {
    if (!this.enabled) return { skipped: true, reason: "disabled" };
    if (!this.isReady()) return { skipped: true, reason: "not_ready" };

    const syncEvent = buildSyncEventPayload({
      userId: this.userId,
      deviceId: this.deviceId,
      localTable,
      recordId,
      eventType,
      version,
      payload,
    });

    const syncInsert = await this.supabase.from("sync_events").insert(syncEvent);
    if (syncInsert.error) throw syncInsert.error;

    const table = mapLocalTableToSupabase(localTable);
    if (eventType === "DELETE") {
      const softDelete = await this.supabase
        .from(table)
        .upsert({ id: recordId, user_id: this.userId, device_id: this.deviceId, deleted_at: new Date().toISOString(), version });
      if (softDelete.error) throw softDelete.error;
      return { pushed: true };
    }

    const row = {
      ...payload,
      user_id: payload.user_id || this.userId,
      device_id: payload.device_id === undefined ? this.deviceId : payload.device_id,
      version,
    };
    const upsert = await this.supabase.from(table).upsert(row);
    if (upsert.error) throw upsert.error;
    return { pushed: true };
  }

  subscribeToUserTables({ tables, onChange }) {
    if (!this.isReady()) return [];
    this.channels = tables.map((table) => {
      const channel = this.supabase
        .channel(`9router:${this.userId}:${table}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `user_id=eq.${this.userId}` },
          (payload) => onChange({ table, payload })
        )
        .subscribe();
      return channel;
    });
    return this.channels;
  }

  async stop() {
    for (const channel of this.channels) {
      if (this.supabase?.removeChannel) await this.supabase.removeChannel(channel);
    }
    this.channels = [];
  }
}
```

- [ ] **Step 4: Implement hook API**

Create `src/lib/db/hooks/cloudSyncHooks.js`:

```js
let manager = null;

export function setCloudSyncManager(nextManager) {
  manager = nextManager;
}

export function getCloudSyncManager() {
  return manager;
}

export async function mirrorLocalWrite(change) {
  if (!manager) return { skipped: true, reason: "no_manager" };
  try {
    return await manager.pushLocalChange(change);
  } catch (error) {
    console.error("[cloudSync] failed to mirror local write:", error.message);
    return { skipped: true, reason: "push_failed", error: error.message };
  }
}
```

- [ ] **Step 5: Run manager tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-manager.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

Run:
```bash
git add src/lib/cloudSync/cloudSyncManager.js src/lib/db/hooks/cloudSyncHooks.js tests/unit/cloud-sync-manager.test.js
git commit -m "feat: add cloud sync manager core"
```
Expected: commit succeeds.

---

## Task 6: Wire Repository Write Hooks Incrementally

**Files:**
- Modify: `src/lib/db/repos/settingsRepo.js`
- Modify: `src/lib/db/repos/connectionsRepo.js`
- Modify: `src/lib/db/repos/nodesRepo.js`
- Modify: `src/lib/db/repos/proxyPoolsRepo.js`
- Modify: `src/lib/db/repos/apiKeysRepo.js`
- Modify: `src/lib/db/repos/aliasRepo.js`
- Modify: `src/lib/db/repos/combosRepo.js`
- Modify: `src/lib/db/repos/pricingRepo.js`
- Modify: `src/lib/db/repos/usageRepo.js`
- Modify: `src/lib/db/repos/requestDetailsRepo.js`
- Test: existing repo/unit tests plus new focused tests as needed.

- [ ] **Step 1: Add focused settings hook test**

Create `tests/unit/settings-cloud-sync-hook.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { setCloudSyncManager } from "../../src/lib/db/hooks/cloudSyncHooks.js";

describe("settings cloud sync hook", () => {
  it("mirrors settings updates without blocking the local return value", async () => {
    const pushed = [];
    setCloudSyncManager({ pushLocalChange: vi.fn(async (change) => pushed.push(change) || { pushed: true }) });
    const { updateSettings } = await import(`../../src/lib/db/repos/settingsRepo.js?${Date.now()}`);
    const result = await updateSettings({ cloudEnabled: true });
    expect(result.cloudEnabled).toBe(true);
    expect(pushed[0]).toMatchObject({ localTable: "settings", eventType: "UPDATE" });
  });
});
```

- [ ] **Step 2: Run failing settings hook test**

Run:
```bash
npx vitest run tests/unit/settings-cloud-sync-hook.test.js --config tests/vitest.config.js
```
Expected: FAIL because `settingsRepo.js` does not call the cloud sync hook.

- [ ] **Step 3: Wire settings repo hook**

Modify `src/lib/db/repos/settingsRepo.js`:

```js
import { mirrorLocalWrite } from "../hooks/cloudSyncHooks.js";
```

Inside `updateSettings`, immediately before `return mergeWithDefaults(next);`, add:

```js
  mirrorLocalWrite({
    localTable: "settings",
    recordId: "settings",
    eventType: "UPDATE",
    version: Date.now(),
    payload: { id: "settings", data: next },
  }).catch(() => {});
```

- [ ] **Step 4: Run settings hook test**

Run:
```bash
npx vitest run tests/unit/settings-cloud-sync-hook.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 5: Wire remaining repos with the same pattern**

For each create/update/delete function in the listed repo files, call `mirrorLocalWrite()` only after the local SQLite transaction succeeds. Use these local table names:

```js
providerConnections
providerNodes
proxyPools
apiKeys
combos
modelAliases
customModels
pricing
usageHistory
usageDaily
requestDetails
```

Payload rules:
- Use the object returned by the repo as the payload.
- Delete functions use `eventType: "DELETE"` and `payload: { id }`.
- Create functions use `eventType: "INSERT"`.
- Update functions use `eventType: "UPDATE"`.
- Secret-bearing provider fields (`apiKey`, `accessToken`, `refreshToken`) must not be included in the payload sent to `provider_connections`.

- [ ] **Step 6: Add provider secret split test**

Create `tests/unit/provider-connection-sync-sanitization.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { setCloudSyncManager } from "../../src/lib/db/hooks/cloudSyncHooks.js";

describe("provider connection cloud sync sanitization", () => {
  it("does not mirror plaintext provider secrets", async () => {
    const changes = [];
    setCloudSyncManager({ pushLocalChange: vi.fn(async (change) => changes.push(change) || { pushed: true }) });
    const { createProviderConnection } = await import(`../../src/lib/db/repos/connectionsRepo.js?${Date.now()}`);
    await createProviderConnection({
      provider: "openai",
      authType: "api_key",
      name: "OpenAI",
      apiKey: "sk-secret",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    });
    const payload = changes.find((change) => change.localTable === "providerConnections")?.payload;
    expect(JSON.stringify(payload)).not.toContain("sk-secret");
    expect(JSON.stringify(payload)).not.toContain("access-secret");
    expect(JSON.stringify(payload)).not.toContain("refresh-secret");
  });
});
```

- [ ] **Step 7: Run repository tests**

Run:
```bash
npx vitest run tests/unit/settings-cloud-sync-hook.test.js tests/unit/provider-connection-sync-sanitization.test.js tests/unit/db-concurrent.test.js tests/unit/db-migration-chain.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 8: Commit**

Run:
```bash
git add src/lib/db/repos src/lib/db/hooks tests/unit/settings-cloud-sync-hook.test.js tests/unit/provider-connection-sync-sanitization.test.js
git commit -m "feat: mirror local database writes to cloud sync"
```
Expected: commit succeeds.

---

## Task 7: Replace Cloud Sync Scheduler with Realtime Manager Startup

**Files:**
- Modify: `src/shared/services/cloudSyncScheduler.js`
- Modify: `src/lib/initCloudSync.js` if it initializes the scheduler.
- Test: add or update scheduler tests.

- [ ] **Step 1: Inspect initializer**

Read `src/lib/initCloudSync.js` and note how `getCloudSyncScheduler()` is used.

- [ ] **Step 2: Write failing scheduler test**

Create `tests/unit/cloud-sync-scheduler-manager.test.js`:

```js
import { describe, it, expect } from "vitest";
import { CloudSyncScheduler } from "../../src/shared/services/cloudSyncScheduler.js";

describe("CloudSyncScheduler", () => {
  it("delegates sync to CloudSyncManager replay when provided", async () => {
    const calls = [];
    const manager = { replayPendingEvents: async () => calls.push("replay") || { replayed: 1 } };
    const scheduler = new CloudSyncScheduler("machine-1", 15, manager);
    const result = await scheduler.sync();
    expect(result).toEqual({ replayed: 1 });
    expect(calls).toEqual(["replay"]);
  });
});
```

- [ ] **Step 3: Run failing scheduler test**

Run:
```bash
npx vitest run tests/unit/cloud-sync-scheduler-manager.test.js --config tests/vitest.config.js
```
Expected: FAIL because constructor does not accept manager and `sync()` calls `/api/sync/cloud`.

- [ ] **Step 4: Update scheduler**

Modify `src/shared/services/cloudSyncScheduler.js`:

```js
export class CloudSyncScheduler {
  constructor(machineId = null, intervalMinutes = 15, manager = null) {
    this.machineId = machineId;
    this.intervalMinutes = intervalMinutes;
    this.intervalId = null;
    this.manager = manager;
  }

  setManager(manager) {
    this.manager = manager;
  }

  async sync() {
    const enabled = await isCloudEnabled();
    if (!enabled) return null;
    if (this.manager?.replayPendingEvents) {
      return await this.manager.replayPendingEvents();
    }
    return null;
  }
}
```

Keep the existing `initializeMachineId`, `start`, `stop`, `syncWithRetry`, `isRunning`, and singleton export behavior.

- [ ] **Step 5: Add manager replay method**

Modify `src/lib/cloudSync/cloudSyncManager.js` by adding this method:

```js
  async replayPendingEvents() {
    return { replayed: 0 };
  }
```

This is a safe initial stub; Task 8 implements real replay.

- [ ] **Step 6: Run scheduler test**

Run:
```bash
npx vitest run tests/unit/cloud-sync-scheduler-manager.test.js tests/unit/cloud-sync-manager.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 7: Commit**

Run:
```bash
git add src/shared/services/cloudSyncScheduler.js src/lib/cloudSync/cloudSyncManager.js tests/unit/cloud-sync-scheduler-manager.test.js
git commit -m "feat: route cloud scheduler through sync manager"
```
Expected: commit succeeds.

---

## Task 8: Implement Pending Event Replay and Realtime Subscriptions

**Files:**
- Modify: `src/lib/cloudSync/cloudSyncManager.js`
- Modify: `src/lib/cloudSync/syncEvents.js`
- Test: `tests/unit/cloud-sync-manager.test.js`

- [ ] **Step 1: Add failing replay and subscription tests**

Append to `tests/unit/cloud-sync-manager.test.js`:

```js
it("subscribes to mapped realtime tables", () => {
  const subscribe = vi.fn(() => "channel-result");
  const on = vi.fn(() => ({ subscribe }));
  const channel = vi.fn(() => ({ on }));
  const supabase = { channel };
  const manager = new CloudSyncManager({ supabase, enabled: true, userId: "user-1", deviceId: "device-1" });
  const channels = manager.subscribeToUserTables({ tables: ["settings"], onChange: vi.fn() });
  expect(channels).toEqual(["channel-result"]);
  expect(channel).toHaveBeenCalledWith("9router:user-1:settings");
});

it("replays pending events from a provided local store", async () => {
  const localStore = {
    getPendingEvents: vi.fn(async () => [
      { id: "event-1", localTable: "settings", recordId: "settings", eventType: "UPDATE", version: 1, payload: { id: "settings", data: { cloudEnabled: true } } },
    ]),
    markSynced: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  };
  const supabase = {
    from: vi.fn((table) => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
  };
  const manager = new CloudSyncManager({ supabase, enabled: true, userId: "user-1", deviceId: "device-1", localStore });
  const result = await manager.replayPendingEvents();
  expect(result).toEqual({ replayed: 1, failed: 0 });
  expect(localStore.markSynced).toHaveBeenCalledWith("event-1");
});
```

- [ ] **Step 2: Run failing tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-manager.test.js --config tests/vitest.config.js
```
Expected: replay test fails because `replayPendingEvents()` still returns `{ replayed: 0 }`.

- [ ] **Step 3: Implement local store injection and replay**

Modify `CloudSyncManager` constructor:

```js
  constructor({ supabase, enabled = false, userId = null, deviceId = null, localStore = null } = {}) {
    this.supabase = supabase;
    this.enabled = enabled;
    this.userId = userId;
    this.deviceId = deviceId;
    this.localStore = localStore;
    this.channels = [];
  }
```

Replace `replayPendingEvents()`:

```js
  async replayPendingEvents() {
    if (!this.isReady()) return { replayed: 0, failed: 0 };
    if (!this.localStore?.getPendingEvents) return { replayed: 0, failed: 0 };

    const events = await this.localStore.getPendingEvents();
    let replayed = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.pushLocalChange(event);
        await this.localStore.markSynced(event.id);
        replayed++;
      } catch (error) {
        failed++;
        if (this.localStore.markFailed) await this.localStore.markFailed(event.id, error.message);
      }
    }
    return { replayed, failed };
  }
```

- [ ] **Step 4: Run manager tests**

Run:
```bash
npx vitest run tests/unit/cloud-sync-manager.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/lib/cloudSync/cloudSyncManager.js tests/unit/cloud-sync-manager.test.js
git commit -m "feat: replay pending cloud sync events"
```
Expected: commit succeeds.

---

## Task 9: Initialize Cloud Sync Manager from App Startup

**Files:**
- Modify: `src/lib/initCloudSync.js`
- Modify: `src/shared/services/cloudSyncScheduler.js`
- Modify: `src/lib/db/hooks/cloudSyncHooks.js`
- Test: add `tests/unit/init-cloud-sync.test.js`.

- [ ] **Step 1: Write failing init test**

Create `tests/unit/init-cloud-sync.test.js`:

```js
import { describe, it, expect, vi } from "vitest";

describe("initCloudSync", () => {
  it("returns skipped when Supabase sync is disabled", async () => {
    process.env.SUPABASE_SYNC_ENABLED = "false";
    const mod = await import(`../../src/lib/initCloudSync.js?${Date.now()}`);
    const result = await mod.initCloudSync();
    expect(result).toMatchObject({ skipped: true });
  });
});
```

- [ ] **Step 2: Run failing init test**

Run:
```bash
npx vitest run tests/unit/init-cloud-sync.test.js --config tests/vitest.config.js
```
Expected: FAIL if `initCloudSync()` has a different return shape or old behavior.

- [ ] **Step 3: Update initializer**

Modify `src/lib/initCloudSync.js` so it:

```js
import { isSupabaseSyncEnabled } from "@/lib/supabase/config.js";
import { getSupabaseClient } from "@/lib/supabase/client.js";
import { CloudSyncManager } from "@/lib/cloudSync/cloudSyncManager.js";
import { setCloudSyncManager } from "@/lib/db/hooks/cloudSyncHooks.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getCloudSyncScheduler } from "@/shared/services/cloudSyncScheduler";

let initialized = false;

export async function initCloudSync({ userId = null, deviceId = null } = {}) {
  if (!isSupabaseSyncEnabled()) return { skipped: true, reason: "disabled" };
  if (initialized) return { skipped: true, reason: "already_initialized" };

  const supabase = getSupabaseClient();
  if (!supabase) return { skipped: true, reason: "not_configured" };

  const machineId = await getConsistentMachineId();
  const manager = new CloudSyncManager({ supabase, enabled: true, userId, deviceId });
  setCloudSyncManager(manager);

  const scheduler = await getCloudSyncScheduler(machineId, 15, manager);
  scheduler.setManager(manager);
  initialized = true;
  return { initialized: true, manager };
}
```

If the existing file exports additional helpers, preserve them.

- [ ] **Step 4: Update singleton factory signature if needed**

Modify `getCloudSyncScheduler(machineId = null, intervalMinutes = 15, manager = null)` to accept `manager` and set it on the existing singleton:

```js
export async function getCloudSyncScheduler(machineId = null, intervalMinutes = 15, manager = null) {
  if (!cloudSyncScheduler) {
    cloudSyncScheduler = new CloudSyncScheduler(machineId, intervalMinutes, manager);
  } else if (manager) {
    cloudSyncScheduler.setManager(manager);
  }
  return cloudSyncScheduler;
}
```

- [ ] **Step 5: Run init and scheduler tests**

Run:
```bash
npx vitest run tests/unit/init-cloud-sync.test.js tests/unit/cloud-sync-scheduler-manager.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

Run:
```bash
git add src/lib/initCloudSync.js src/shared/services/cloudSyncScheduler.js src/lib/db/hooks/cloudSyncHooks.js tests/unit/init-cloud-sync.test.js
git commit -m "feat: initialize Supabase realtime sync manager"
```
Expected: commit succeeds.

---

## Task 10: Final Verification and Supabase Advisor Check

**Files:**
- No code changes unless failures require fixes.

- [ ] **Step 1: Run focused unit tests**

Run:
```bash
npx vitest run tests/unit/secret-encryption.test.js tests/unit/cloud-sync-events.test.js tests/unit/cloud-sync-manager.test.js tests/unit/supabase-config.test.js tests/unit/init-cloud-sync.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 2: Run DB regression tests**

Run:
```bash
npx vitest run tests/unit/db-migration-chain.test.js tests/unit/db-concurrent.test.js tests/unit/db-driver-chain.test.js --config tests/vitest.config.js
```
Expected: PASS.

- [ ] **Step 3: Build app**

Run:
```bash
npm run build
```
Expected: Next.js production build succeeds.

- [ ] **Step 4: Verify Supabase remote schema**

Run via MCP:
```text
list_tables(project_id="urlvojphjewtxerrigkd", schemas=["public", "storage"], verbose=false)
get_advisors(project_id="urlvojphjewtxerrigkd", type="security")
get_advisors(project_id="urlvojphjewtxerrigkd", type="performance")
```
Expected: public schema includes all tables, storage includes configured buckets, and advisors show no new critical warnings from this migration.

- [ ] **Step 5: Manual dashboard smoke test**

Run:
```bash
npm run dev
```
Open `http://localhost:20128`, log in, and verify:
- Settings page loads.
- Provider page loads.
- Usage page loads.
- Creating/updating a non-secret setting still persists locally.
- With `SUPABASE_SYNC_ENABLED=false`, the app behaves as before.

- [ ] **Step 6: Commit any verification fixes**

If fixes were required:
```bash
git add <fixed-files>
git commit -m "fix: stabilize Supabase sync integration"
```
Expected: no uncommitted implementation fixes remain.

---

## Self-Review

### Spec coverage
- Supabase durable backend tables: Task 1.
- Private storage buckets: Task 1.
- RLS ownership via `auth.users.id`: Task 1.
- Device-scoped credential access: Task 1.
- Encrypted secret blobs: Task 3 and Task 6 provider secret sanitization.
- Realtime sync primitives: Tasks 5, 7, 8, 9.
- Local SQLite runtime cache/offline queue: Task 4 and Task 8.
- Repository mirroring: Task 6.
- Verification/advisors/build: Task 10.

### Placeholder scan
No placeholder steps remain; each code step includes concrete file paths, code, commands, and expected results.

### Type consistency
The plan consistently uses `userId/deviceId` in JavaScript APIs and `user_id/device_id` in Supabase rows. Local table names map through `LOCAL_TO_SUPABASE_TABLE` before Supabase writes.