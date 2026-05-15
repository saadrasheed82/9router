/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/config.js", () => ({
  isSupabaseSyncEnabled: vi.fn(),
  isSupabaseConfigured: vi.fn(),
}));

vi.mock("@/lib/supabase/client.js", () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/shared/services/cloudSyncScheduler", () => ({
  getCloudSyncScheduler: vi.fn(),
}));

vi.mock("@/lib/cloudSync/applyRemoteChange.js", () => ({
  applyRemoteChange: vi.fn(),
}));

// Reset the module-level global between tests
beforeEach(() => {
  // @ts-ignore
  delete globalThis.__cloudSyncInit;
  vi.resetModules();
});

describe("initCloudSync", () => {
  it("returns skipped when Supabase sync is disabled", async () => {
    const { isSupabaseSyncEnabled } = await import("@/lib/supabase/config.js");
    isSupabaseSyncEnabled.mockReturnValue(false);

    const mod = await import("../../src/lib/initCloudSync.js");
    const result = await mod.initCloudSync();
    expect(result).toMatchObject({ skipped: true });
  });

  it("returns skipped when no supabase client is available", async () => {
    const { isSupabaseSyncEnabled } = await import("@/lib/supabase/config.js");
    const { getSupabaseClient } = await import("@/lib/supabase/client.js");
    const { getConsistentMachineId } = await import("@/shared/utils/machineId");

    isSupabaseSyncEnabled.mockReturnValue(true);
    getSupabaseClient.mockReturnValue(null);
    getConsistentMachineId.mockResolvedValue("machine-1");

    const mod = await import("../../src/lib/initCloudSync.js");
    const result = await mod.initCloudSync();
    expect(result).toMatchObject({ skipped: true, reason: "not_configured" });
  });

  it("initializes manager, scheduler, and subscribes to remote tables", async () => {
    const { isSupabaseSyncEnabled } = await import("@/lib/supabase/config.js");
    const { getSupabaseClient } = await import("@/lib/supabase/client.js");
    const { getConsistentMachineId } = await import("@/shared/utils/machineId");
    const { getCloudSyncScheduler } = await import("@/shared/services/cloudSyncScheduler");

    isSupabaseSyncEnabled.mockReturnValue(true);

    const mockSupabase = {
      channel: vi.fn().mockReturnValue({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      }),
      removeChannel: vi.fn(),
    };
    getSupabaseClient.mockReturnValue(mockSupabase);
    getConsistentMachineId.mockResolvedValue("device-abc");

    const mockScheduler = { setManager: vi.fn() };
    getCloudSyncScheduler.mockResolvedValue(mockScheduler);

    const mod = await import("../../src/lib/initCloudSync.js");
    const result = await mod.initCloudSync({ userId: "user-1", deviceId: "device-abc" });

    expect(result).toMatchObject({ initialized: true });
    expect(mockScheduler.setManager).toHaveBeenCalled();
    expect(mockSupabase.channel).toHaveBeenCalled();
  });
});