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

describe("initCloudSync", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns skipped when Supabase sync is disabled", async () => {
    const { isSupabaseSyncEnabled } = await import("@/lib/supabase/config.js");
    isSupabaseSyncEnabled.mockReturnValue(false);

    const mod = await import("../../src/lib/initCloudSync.js");
    const result = await mod.initCloudSync();
    expect(result).toMatchObject({ skipped: true });
  });
});