/**
 * applyRemoteChange — applies incoming Supabase Realtime changes to local SQLite.
 *
 * Deduplication strategy:
 * - Events from the current device are skipped (they were already applied locally).
 * - INSERT: always applied (no local version check needed).
 * - UPDATE/DELETE: compared via `updated_at` / `version` to avoid overwriting newer local data.
 *
 * This function intentionally does NOT call mirrorLocalWrite — remote changes from Supabase
 * should not be re-pushed back to Supabase (no feedback loop).
 */

import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { mergeLocalProviderConnectionData } from "./providerConnectionSyncMap.js";
import { LOCAL_TO_SUPABASE_TABLE } from "./tableMap.js";

// Reverse lookup: Supabase table name -> local table name
const SUPABASE_TO_LOCAL_TABLE = Object.fromEntries(
  Object.entries(LOCAL_TO_SUPABASE_TABLE).map(([local, supabase]) => [supabase, local])
);

// Maps a realtime payload's new record to the local SQLite column schema.
// Returns null to skip the event.
function normalizePayload(table, newRec, existingDataStr = null) {
  if (!newRec) return null;

  switch (table) {
    case "provider_connections": {
      // Supabase uses typed columns + provider_specific_data; local SQLite stores extras in JSON `data`.
      const id = newRec.id;
      const provider = newRec.provider;
      if (!id || !provider) return null;
      const auth_type = newRec.auth_type ?? newRec.authType;
      const is_active = newRec.is_active ?? newRec.isActive;
      const created_at = newRec.created_at ?? newRec.createdAt;
      const updated_at = newRec.updated_at ?? newRec.updatedAt;
      const activeBool = is_active === undefined || is_active === null ? true : Boolean(is_active);
      return {
        id,
        provider,
        authType: auth_type ?? "oauth",
        name: newRec.name ?? null,
        email: newRec.email ?? null,
        priority: newRec.priority ?? null,
        isActive: activeBool ? 1 : 0,
        data: mergeLocalProviderConnectionData(existingDataStr, newRec),
        createdAt: created_at ?? null,
        updatedAt: updated_at ?? null,
      };
    }
    case "provider_nodes": {
      const { id, type, name, data, created_at, updated_at } = newRec;
      if (!id) return null;
      return {
        id,
        type: type ?? null,
        name: name ?? null,
        data: typeof data === "object" ? JSON.stringify(data) : (data ?? "{}"),
        createdAt: created_at ?? null,
        updatedAt: updated_at ?? null,
      };
    }
    case "proxy_pools": {
      const { id, name, data, created_at, updated_at } = newRec;
      if (!id) return null;
      return {
        id,
        name: name ?? null,
        data: typeof data === "object" ? JSON.stringify(data) : (data ?? "{}"),
        createdAt: created_at ?? null,
        updatedAt: updated_at ?? null,
      };
    }
    case "api_keys": {
      const { id, key, name, machine_id, is_active, created_at } = newRec;
      if (!id) return null;
      return {
        id,
        key: key ?? null,
        name: name ?? null,
        machineId: machine_id ?? null,
        isActive: is_active ? 1 : 0,
        createdAt: created_at ?? null,
      };
    }
    case "combos": {
      const { id, name, kind, models, created_at, updated_at } = newRec;
      if (!id) return null;
      return {
        id,
        name: name ?? null,
        kind: kind ?? null,
        models: Array.isArray(models) ? JSON.stringify(models) : (models ?? "[]"),
        createdAt: created_at ?? null,
        updatedAt: updated_at ?? null,
      };
    }
    case "settings": {
      // Settings is upserted by id="settings"
      const { id, data } = newRec;
      if (!id) return null;
      return {
        id,
        data: typeof data === "object" ? JSON.stringify(data) : (data ?? "{}"),
      };
    }
    case "pricing_overrides": {
      // Stored in KV store, not a SQLite table — handled separately
      return null;
    }
    case "usage_events":
    case "usage_daily":
    case "request_details": {
      // Append-only / aggregated tables — apply INSERT but skip deduplication
      return newRec;
    }
    case "model_aliases":
    case "custom_models": {
      const { id, data, created_at, updated_at } = newRec;
      if (!id) return null;
      return {
        id,
        data: typeof data === "object" ? JSON.stringify(data) : (data ?? "{}"),
        createdAt: created_at ?? null,
        updatedAt: updated_at ?? null,
      };
    }
    default:
      return null;
  }
}

// Returns the local updatedAt for comparison, or null if record doesn't exist.
function getLocalUpdatedAt(db, localTable, recordId) {
  try {
    if (localTable === "settings") {
      const row = db.get(`SELECT data FROM settings WHERE id = ?`, [recordId]);
      if (!row) return null;
      const parsed = parseJson(row.data, {});
      return parsed.updatedAt ?? null;
    }
    if (localTable === "apiKeys") {
      const row = db.get(`SELECT createdAt FROM apiKeys WHERE id = ?`, [recordId]);
      return row?.createdAt ?? null;
    }
    const row = db.get(`SELECT updatedAt FROM ${localTable} WHERE id = ?`, [recordId]);
    return row?.updatedAt ?? null;
  } catch {
    return null;
  }
}

// Returns true if the remote event should be skipped because local data is newer.
function shouldSkipDueToStaleness(localTable, localUpdatedAt, remoteRecord) {
  if (!localUpdatedAt) return false; // No local record — always apply
  const remoteUpdatedAt = remoteRecord?.updated_at ?? remoteRecord?.updatedAt ?? null;
  if (!remoteUpdatedAt) return false; // No remote timestamp — apply anyway

  const localTime = new Date(localUpdatedAt).getTime();
  const remoteTime = new Date(remoteUpdatedAt).getTime();

  // Allow 1s clock drift tolerance
  return localTime > remoteTime + 1000;
}

export async function applyRemoteChange({ table, payload, currentDeviceId }) {
  const localTable = SUPABASE_TO_LOCAL_TABLE[table];
  if (!localTable) return { applied: false, reason: "unknown_table" };

  const { eventType, new: newRecord, old: oldRecord } = payload;
  if (!newRecord && !oldRecord) return { applied: false, reason: "no_record" };

  // Skip DELETE without a recordId
  const recordId = newRecord?.id ?? oldRecord?.id;
  if (!recordId) return { applied: false, reason: "no_record_id" };

  // Skip events from the current device (already applied locally)
  const remoteDeviceId = newRecord?.device_id ?? oldRecord?.device_id;
  if (remoteDeviceId && remoteDeviceId === currentDeviceId) {
    return { applied: false, reason: "self_event" };
  }

  // Supabase tombstone (deleted_at) — remove locally (realtime often sends UPDATE, not DELETE)
  if (table === "provider_connections" && newRecord) {
    const deletedAt = newRecord.deleted_at ?? newRecord.deletedAt;
    if (deletedAt && eventType !== "DELETE") {
      const db = await getAdapter();
      try {
        db.run(`DELETE FROM providerConnections WHERE id = ?`, [recordId]);
      } catch {
        // ignore
      }
      return { applied: true, table: localTable, recordId, eventType: "DELETE", reason: "soft_delete" };
    }
  }

  // Handle DELETE
  if (eventType === "DELETE") {
    const db = await getAdapter();
    try {
      db.run(`DELETE FROM ${localTable} WHERE id = ?`, [recordId]);
    } catch {
      // Table might not exist or already deleted — that's fine
    }
    return { applied: true, table: localTable, recordId, eventType: "DELETE" };
  }

  // Handle INSERT — always apply (no local state to check)
  if (eventType === "INSERT") {
    const db = await getAdapter();
    let existingDataStr = null;
    if (table === "provider_connections") {
      const row = db.get(`SELECT data FROM providerConnections WHERE id = ?`, [recordId]);
      existingDataStr = row?.data ?? null;
    }
    const normalized = normalizePayload(table, newRecord, existingDataStr);
    if (!normalized) return { applied: false, reason: "normalization_failed" };

    if (localTable === "providerConnections") {
      db.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider=excluded.provider, authType=excluded.authType, name=excluded.name,
           email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
           data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.provider, normalized.authType, normalized.name,
         normalized.email, normalized.priority, normalized.isActive, normalized.data,
         normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "providerNodes") {
      db.run(
        `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.type, normalized.name, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "proxyPools") {
      db.run(
        `INSERT INTO proxyPools(id, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.name, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "apiKeys") {
      db.run(
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key=excluded.key, name=excluded.name, machineId=excluded.machineId, isActive=excluded.isActive`,
        [normalized.id, normalized.key, normalized.name, normalized.machineId, normalized.isActive, normalized.createdAt]
      );
    } else if (localTable === "combos") {
      db.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, kind=excluded.kind, models=excluded.models, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.name, normalized.kind, normalized.models, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "settings") {
      db.run(
        `INSERT INTO settings(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [normalized.id, normalized.data]
      );
    } else if (localTable === "modelAliases" || localTable === "customModels") {
      db.run(
        `INSERT INTO ${localTable}(id, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    }
    // Skip usage_events / usage_daily / request_details (append-only, or handled separately)
    return { applied: true, table: localTable, recordId, eventType: "INSERT" };
  }

  // Handle UPDATE — check staleness before applying
  if (eventType === "UPDATE") {
    const db = await getAdapter();
    const localUpdatedAt = getLocalUpdatedAt(db, localTable, recordId);

    if (shouldSkipDueToStaleness(localTable, localUpdatedAt, newRecord)) {
      return { applied: false, reason: "local_is_newer" };
    }

    let existingDataStr = null;
    if (table === "provider_connections") {
      const row = db.get(`SELECT data FROM providerConnections WHERE id = ?`, [recordId]);
      existingDataStr = row?.data ?? null;
    }
    const normalized = normalizePayload(table, newRecord, existingDataStr);
    if (!normalized) return { applied: false, reason: "normalization_failed" };

    if (localTable === "providerConnections") {
      db.run(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider=excluded.provider, authType=excluded.authType, name=excluded.name,
           email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
           data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.provider, normalized.authType, normalized.name,
         normalized.email, normalized.priority, normalized.isActive, normalized.data,
         normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "providerNodes") {
      db.run(
        `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.type, normalized.name, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "proxyPools") {
      db.run(
        `INSERT INTO proxyPools(id, name, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.name, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "apiKeys") {
      db.run(
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key=excluded.key, name=excluded.name, machineId=excluded.machineId, isActive=excluded.isActive`,
        [normalized.id, normalized.key, normalized.name, normalized.machineId, normalized.isActive, normalized.createdAt]
      );
    } else if (localTable === "combos") {
      db.run(
        `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, kind=excluded.kind, models=excluded.models, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.name, normalized.kind, normalized.models, normalized.createdAt, normalized.updatedAt]
      );
    } else if (localTable === "settings") {
      db.run(
        `INSERT INTO settings(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
        [normalized.id, normalized.data]
      );
    } else if (localTable === "modelAliases" || localTable === "customModels") {
      db.run(
        `INSERT INTO ${localTable}(id, data, createdAt, updatedAt)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           data=excluded.data, updatedAt=excluded.updatedAt`,
        [normalized.id, normalized.data, normalized.createdAt, normalized.updatedAt]
      );
    }

    return { applied: true, table: localTable, recordId, eventType: "UPDATE" };
  }

  return { applied: false, reason: "unknown_event_type" };
}