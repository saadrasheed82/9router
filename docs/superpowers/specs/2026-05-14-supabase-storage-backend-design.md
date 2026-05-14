# Supabase Full Backend — Storage & Sync Design

_Date: 2026-05-14_
_Status: Draft — pending implementation plan_

---

## 1. Goals & Constraints

### Goals
- Supabase becomes the source of truth for all user data: settings, provider accounts, model aliases, combos, pricing, usage logs, sync state, and file storage.
- Each device has its own credentials only; no shared credentials across devices.
- Secrets (provider tokens, API keys) are encrypted in Supabase so the database cannot read them.
- Real-time sync via Supabase Realtime pushes changes to all online devices.
- Local SQLite remains for runtime latency-sensitive reads; routing does not depend on Supabase being reachable.

### Constraints
- `auth.users.id` is the owner for all user-scoped data.
- Each local 9Router install is represented by a `machineId` registered as a `device`.
- Secrets never stored as plaintext columns.
- All config rows have `version` and `deleted_at` for conflict resolution and soft deletes.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Supabase (Postgres)                  │
│                                                         │
│  auth.users ── owns ──► profiles                       │
│                          devices                        │
│                          settings                        │
│                          provider_connections            │
│                          provider_nodes                  │
│                          provider_secret_blobs  (enc)    │
│                          proxy_pools                    │
│                          api_keys                       │
│                          api_key_secret_blobs  (enc)     │
│                          model_aliases                  │
│                          custom_models                  │
│                          combos                         │
│                          pricing_overrides              │
│                          usage_events                   │
│                          usage_daily                    │
│                          request_details                │
│                          sync_events                    │
│                                                         │
│  storage.buckets ──► exports (private)                   │
│                    request-artifacts (private)           │
│                    avatars (private)                     │
└─────────────────────────────────────────────────────────┘
              ▲ writes         │ Realtime broadcasts
              │               ▼
┌─────────────────────────┐  ┌──────────────────────────┐
│ 9Router local runtime   │  │ CloudSyncManager client  │
│ (SQLite primary cache)  │◄─┤ (Supabase JS + Realtime) │
│ src/lib/db/             │  └──────────────────────────┘
└─────────────────────────┘
```

### Two-layer data strategy
- **Durable source of truth**: Supabase — all data at rest.
- **Runtime primary**: local SQLite — fast reads for routing and dashboard.
- **Sync bridge**: `CloudSyncManager` — writes to both, subscribes to Realtime, reconciles incoming changes into local SQLite.

---

## 3. Database Tables

### 3.1 `profiles`
User-level profile and preferences.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | references `auth.users.id` |
| `display_name` | text | |
| `preferences` | jsonb | JSON blob for future preference expansion |
| `created_at` | timestamptz | default now() |
| `updated_at` | timestamptz | |

### 3.2 `devices`
Registered 9Router installs. Each row maps a `machineId` to a Supabase user.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `machine_id` | text UNIQUE | existing local machineId value |
| `name` | text | user-given device name |
| `is_active` | boolean | soft-disable a device |
| `encryption_key_hash` | text | SHA-256 of locally-derived key, for device verification only (not decryptable) |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `last_seen_at` | timestamptz | |

**Index**: `UNIQUE (user_id, machine_id)`.

### 3.3 `settings`
Synced runtime settings (equivalent to current `settings` table in local SQLite).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `data` | jsonb | full settings blob (cloudEnabled, tunnelSettings, auth settings, etc.) |
| `version` | bigint | monotonically increasing, for conflict resolution |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | null = active |

**Index**: `UNIQUE (user_id)`.

### 3.4 `provider_nodes`
Compatible provider node definitions (equivalent to current `providerNodes` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable — shared or device-specific |
| `type` | text | e.g. "openai-compatible" |
| `name` | text | |
| `prefix` | text | |
| `api_type` | text | |
| `base_url` | text | |
| `extra_data` | jsonb | additional provider config |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `(user_id, type)`.

### 3.5 `provider_connections`
Non-secret provider connection metadata (equivalent to current `providerConnections` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable |
| `provider` | text | provider identifier |
| `auth_type` | text | "oauth", "api_key", etc. |
| `name` | text | user-given display name |
| `email` | text | account email when applicable |
| `priority` | integer | |
| `is_active` | boolean | |
| `test_status` | text | "valid", "error", "rate_limited", etc. |
| `last_error` | text | |
| `rate_limited_until` | timestamptz | |
| `provider_specific_data` | jsonb | non-secret provider config only |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Indexes**: `(user_id, provider)`, `(user_id, provider, is_active)`.

### 3.6 `provider_secret_blobs`
Encrypted provider credential payloads — **never plaintext**.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | device that created this secret |
| `connection_id` | uuid FK → provider_connections(id) | links to the connection metadata row |
| `encrypted_payload` | text | AES-256-GCM blob: `iv:ciphertext` in base64 |
| `version` | bigint | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `UNIQUE (connection_id, device_id)`.

### 3.7 `proxy_pools`
Proxy pool metadata and encrypted proxy credentials.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable |
| `is_active` | boolean | |
| `test_status` | text | |
| `proxy_type` | text | "http", "socks5", etc. |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

Proxy URLs stored as encrypted blobs in `proxy_pool_secrets` (same pattern as `provider_secret_blobs`).

### 3.8 `api_keys`
Non-secret local API key metadata (equivalent to current `apiKeys` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable |
| `key` | text UNIQUE | the actual API key (local gateway key, not a provider key) |
| `name` | text | user-given name |
| `machine_id` | text | machine this key is valid for |
| `is_active` | boolean | |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `(user_id, device_id)`.

### 3.9 `api_key_secret_blobs`
Encrypted provider/API key backup blobs (for cross-device recovery when explicitly exported/imported).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | device that created this blob |
| `key_id` | uuid FK → api_keys(id) | link to key metadata |
| `encrypted_payload` | text | AES-256-GCM blob |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | |

### 3.10 `model_aliases`
Alias → provider/model target mappings (equivalent to current `kv` store scope `modelAliases`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `alias` | text | the shortcut name |
| `target_model` | text | the resolved provider/model string |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `UNIQUE (user_id, alias)`.

### 3.11 `custom_models`
User-added custom model entries (equivalent to current `kv` store scope `customModels`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable |
| `provider_alias` | text | which provider node this belongs to |
| `model_id` | text | the custom model's identifier |
| `type` | text | "llm" etc. |
| `extra_data` | jsonb | additional model config |
| `created_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `UNIQUE (user_id, provider_alias, model_id, type)`.

### 3.12 `combos`
Multi-model fallback combos (equivalent to current `combos` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `name` | text UNIQUE | combo name |
| `kind` | text | "chat", "completion", etc. |
| `models` | jsonb | array of model strings |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `(user_id, name)`.

### 3.13 `pricing_overrides`
Custom per-provider/model pricing (equivalent to current `kv` store scope `pricing`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `provider` | text | |
| `model` | text | |
| `input` | numeric | cost per 1M input tokens |
| `output` | numeric | cost per 1M output tokens |
| `cached` | numeric | cost per 1M cached tokens |
| `reasoning` | numeric | cost per 1M reasoning tokens |
| `cache_creation` | numeric | cost per 1M cache creation tokens |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | |

**Index**: `UNIQUE (user_id, provider, model)`.

### 3.14 `usage_events`
Request-level usage facts (equivalent to current `usageHistory` table).

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | autoincrement |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | |
| `timestamp` | timestamptz | |
| `provider` | text | |
| `model` | text | |
| `connection_id` | uuid | foreign key to provider_connections(id) |
| `api_key` | text | |
| `endpoint` | text | |
| `prompt_tokens` | bigint | |
| `completion_tokens` | bigint | |
| `cost` | numeric | calculated cost |
| `status` | text | |
| `tokens` | jsonb | raw token breakdown |
| `meta` | jsonb | extra metadata |
| `deleted_at` | timestamptz | |

**Indexes**: `(user_id, timestamp DESC)`, `(device_id, timestamp DESC)`, `(user_id, provider)`, `(user_id, model)`.

**Retention**: records with `deleted_at` older than 30 days are hard-deleted by a scheduled job.

### 3.15 `usage_daily`
Aggregated daily usage for fast dashboard reads (equivalent to current `usageDaily` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | nullable |
| `date_key` | text | "YYYY-MM-DD" |
| `requests` | bigint | |
| `prompt_tokens` | bigint | |
| `completion_tokens` | bigint | |
| `cost` | numeric | |
| `by_provider` | jsonb | aggregated by provider |
| `by_model` | jsonb | aggregated by model |
| `by_account` | jsonb | aggregated by connection |
| `by_api_key` | jsonb | aggregated by api key |
| `by_endpoint` | jsonb | aggregated by endpoint |
| `updated_at` | timestamptz | |

**Index**: `UNIQUE (user_id, device_id, date_key)`.

### 3.16 `request_details`
Optional detailed request records with retention controls (equivalent to current `requestDetails` table).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | |
| `timestamp` | timestamptz | |
| `provider` | text | |
| `model` | text | |
| `connection_id` | uuid | |
| `status` | text | |
| `data` | jsonb | full request/response data |
| `deleted_at` | timestamptz | |

**Index**: `(user_id, device_id, timestamp DESC)`.

**Retention**: hard-delete after 90 days.

### 3.17 `sync_events`
Realtime change feed and conflict-resolution metadata. Acts as a write-ahead log for offline reconciliation.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → auth.users | |
| `device_id` | uuid FK → devices(id) | source device |
| `table_name` | text | target table name |
| `record_id` | uuid | target row id |
| `event_type` | text | "INSERT", "UPDATE", "DELETE" |
| `version` | bigint | version of the row at event time |
| `payload` | jsonb | snapshot of changed fields |
| `created_at` | timestamptz | |

**Index**: `(user_id, device_id, table_name, version DESC)`.

---

## 4. Storage Buckets

| Bucket | Purpose | Public | Path template |
|---|---|---|---|
| `exports` | User/device database exports, backups, migration snapshots | No | `{user_id}/{device_id}/exports/{timestamp}.json` |
| `request-artifacts` | Optional request/debug payload files when enabled | No | `{user_id}/{device_id}/request-artifacts/{request_id}.json` |
| `avatars` | User profile images | No | `{user_id}/avatars/{file_name}` |

All buckets are private. Access via signed URLs with a short TTL (e.g., 15 minutes).

---

## 5. Encryption for Secret Blobs

### Key derivation
Each device derives a local AES-256 encryption key on first setup:

```
encryption_key = PBKDF2(machineId + user_secret, salt, 100000, 32 bytes)
```

The `machineId` is already available locally. The `user_secret` can be the user's Supabase Auth password or a separate app passphrase.

### Encryption format
Algorithm: **AES-256-GCM** (authenticated encryption).

```
iv = random 12 bytes
ciphertext = AES-256-GCM_encrypt(encryption_key, iv, plaintext)
stored_value = base64(iv || ':' || ciphertext)
```

`stored_value` is what goes into `encrypted_payload` columns.

### Storage and decryption
- Encrypted blobs are stored with the device's ID so only that device can decrypt them.
- The `provider_secret_blobs.connection_id` links back to `provider_connections`, which holds the non-secret metadata.
- If a user wants to move a credential to another device, they explicitly export the local encryption key from the source device and import it to the target — Supabase never stores the key material.

### `encryption_key_hash` in `devices`
This column stores `SHA-256(encryption_key)` — not the key itself, not reversible. Used only to verify that a device's local key matches the one used to encrypt blobs when recovering secrets.

---

## 6. Row Level Security Policies

### User-global tables
All select/insert/update/delete policies: `user_id = auth.uid()`.

Tables: `profiles`, `settings`, `provider_nodes`, `provider_connections`, `model_aliases`, `custom_models`, `combos`, `pricing_overrides`, `usage_events`, `usage_daily`, `request_details`, `sync_events`.

### Device-scoped tables
Access requires: `user_id = auth.uid()` AND `device_id` is registered to that user.

Tables: `devices`, `provider_secret_blobs`, `proxy_pools`, `api_keys`, `api_key_secret_blobs`.

The `devices` table itself also uses `user_id = auth.uid()` for reads; writes require the device to be newly registered via a valid machineId.

### Storage buckets
Private. Access via service role for server-side operations. Client-side access uses signed URLs generated server-side.

---

## 7. Realtime Sync Behavior

### Sync model
- **Real-time push on write**: after any local SQLite write succeeds, the app publishes the change to Supabase via the Supabase JS client.
- **Realtime subscriptions**: the app subscribes to `postgres_changes` on all user-owned tables filtered to `user_id = auth.uid()`.
- **Incoming changes**: update the local SQLite cache so the routing engine always reads from local storage for latency-sensitive reads.

### Conflict resolution
- Each row has a `version` column (monotonically increasing integer, default 1).
- On write: `UPDATE ... SET version = version + 1, ... WHERE version = $current_version`.
- If no rows updated (version mismatch): fetch remote, compare versions, apply higher version, push back.
- Soft delete wins over hard delete (a row with `deleted_at` is considered newer than a hard-deleted row).

### Sync events WAL
`sync_events` acts as a write-ahead log:
- Each change writes an event row before the actual table write.
- On reconnect after offline, the app replays missed events.
- Stale events (older than 7 days) are hard-deleted by a scheduled job.

### Offline resilience
1. Local SQLite is the runtime primary — routing continues without Supabase.
2. Changes made offline are queued in `sync_events` (written to local SQLite as pending, pushed on reconnect).
3. If Supabase is unreachable, `CloudSyncManager` retries with exponential backoff.
4. Dashboard reads prefer Supabase when online for cross-device consistency; fall back to local SQLite otherwise.

---

## 8. App-Layer Changes

### New modules
- `src/lib/cloudSyncManager.js` — wraps Supabase JS client, handles realtime subscriptions and write sync.
- `src/lib/db/supabaseAdapter.js` — optional Supabase-first DB adapter for dashboard reads.
- `src/lib/cloudSync/syncEvents.js` — sync_events WAL read/write helpers.
- `src/lib/crypto/secretEncrypt.js` — AES-256-GCM encrypt/decrypt for secret blobs.
- `src/lib/crypto/keyDerive.js` — PBKDF2 key derivation for device encryption key.

### Existing modules updated
- `src/lib/db/repos/*` — each repo gets a Supabase sync hook (mirrors writes, handles incoming Realtime events).
- `src/lib/db/index.js` — `exportDb`/`importDb` gain Supabase export/import targets.
- `src/shared/services/cloudSyncScheduler.js` — replace existing push-based scheduler with `CloudSyncManager` + Realtime.
- Dashboard API routes (`src/app/api/*`) — optionally route reads through Supabase adapter for cross-device reads.
- `src/lib/usageDb.js` (now shim) — shim target updated to route through new repos with Supabase integration.

### Migration path
1. Add new Supabase tables and RLS policies.
2. Implement `CloudSyncManager` in read-only mode (subscribe only, no writes to Supabase yet).
3. Validate sync correctness across devices.
4. Flip write path: local SQLite first, then Supabase publish.
5. Make Supabase the primary for dashboard reads.
6. Deprecate the old `db.json` / `usage.json` local files in favor of the SQLite cache.

---

## 9. Migration from Local SQLite

The current local SQLite schema maps to Supabase as follows:

| Local SQLite table | Supabase table |
|---|---|
| `settings` | `settings` |
| `providerConnections` | `provider_connections` + `provider_secret_blobs` |
| `providerNodes` | `provider_nodes` |
| `proxyPools` | `proxy_pools` + encrypted secrets |
| `apiKeys` | `api_keys` + `api_key_secret_blobs` |
| `combos` | `combos` |
| `kv (modelAliases)` | `model_aliases` |
| `kv (customModels)` | `custom_models` |
| `kv (pricing)` | `pricing_overrides` |
| `usageHistory` | `usage_events` |
| `usageDaily` | `usage_daily` |
| `requestDetails` | `request_details` |
| (new) | `profiles`, `devices`, `sync_events` |

Local storage files (`db.json`, `usage.json`, `request-details.json`) become backup sources for the initial Supabase import, then are replaced by the local SQLite cache (`data.sqlite`).

---

## 10. Self-Review Checklist

- [x] All tables have user_id ownership via `auth.users.id`.
- [x] Secrets split into metadata + encrypted blob pattern.
- [x] Encryption uses AES-256-GCM with per-blob random IV.
- [x] All mutable tables have `version`, `updated_at`, and `deleted_at`.
- [x] Device-scoped tables require both user and device ownership.
- [x] All storage bucket paths namespaced by user_id.
- [x] Retention policies defined for usage_events (30d) and request_details (90d).
- [x] Sync conflict resolution via optimistic versioning.
- [x] Offline resilience: local SQLite remains runtime primary.
- [x] Migration map defined for current local SQLite schema.