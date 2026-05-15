import { isSupabaseSyncEnabled } from "@/lib/supabase/config.js";
import { getSupabaseClient } from "@/lib/supabase/client.js";
import { CloudSyncManager } from "@/lib/cloudSync/cloudSyncManager.js";
import { setCloudSyncManager } from "@/lib/db/hooks/cloudSyncHooks.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getCloudSyncScheduler } from "@/shared/services/cloudSyncScheduler";
import { applyRemoteChange } from "@/lib/cloudSync/applyRemoteChange.js";
import initializeApp from "@/shared/services/initializeApp";

// Tables to subscribe to for reverse sync (Supabase → local SQLite)
const SYNCED_TABLES = [
  "provider_connections",
  "provider_nodes",
  "proxy_pools",
  "api_keys",
  "combos",
  "model_aliases",
  "custom_models",
  "settings",
  "pricing_overrides",
];

// Survive Next.js HMR — module-level flag resets on reload, globalThis persists
const g = globalThis.__cloudSyncInit ??= { initialized: false, inProgress: null };

export async function initCloudSync({ userId = null, deviceId = null } = {}) {
  if (!isSupabaseSyncEnabled()) return { skipped: true, reason: "disabled" };
  if (g.initialized) return { skipped: true, reason: "already_initialized" };

  const supabase = getSupabaseClient();
  if (!supabase) return { skipped: true, reason: "not_configured" };

  const machineId = await getConsistentMachineId();
  const manager = new CloudSyncManager({ supabase, enabled: true, userId, deviceId });
  setCloudSyncManager(manager);

  const scheduler = await getCloudSyncScheduler(machineId, 15, manager);
  scheduler.setManager(manager);

  // Wire reverse sync: listen for remote Supabase changes and apply to local SQLite.
  // This closes the loop so connections created on other devices appear in the dashboard.
  manager.subscribeToUserTables({
    tables: SYNCED_TABLES,
    onChange: ({ table, payload }) => {
      applyRemoteChange({ table, payload, currentDeviceId: deviceId || machineId })
        .catch((err) => console.error(`[CloudSync] applyRemoteChange failed for ${table}:`, err));
    },
  });

  g.initialized = true;
  return { initialized: true, manager };
}

export async function ensureAppInitialized() {
  if (g.initialized) return true;
  if (g.inProgress) return g.inProgress;
  g.inProgress = (async () => {
    try {
      await initializeApp();
      g.initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing app:", error);
    } finally {
      g.inProgress = null;
    }
    return g.initialized;
  })();
  return g.inProgress;
}

// Auto-initialize at runtime only, not during next build.
// Defer to next tick so HTTP server can accept connections before heavy init runs.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  setImmediate(() => {
    ensureAppInitialized().catch(console.log);
  });
}

export default ensureAppInitialized;