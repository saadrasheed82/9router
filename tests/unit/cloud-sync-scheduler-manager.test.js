/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsCloudEnabled = vi.fn();

vi.mock("@/lib/localDb", () => ({
  isCloudEnabled: mockIsCloudEnabled,
}));

const { CloudSyncScheduler } = await import("../../src/shared/services/cloudSyncScheduler.js");

describe("CloudSyncScheduler", () => {
  beforeEach(() => {
    mockIsCloudEnabled.mockResolvedValue(true);
  });

  it("delegates sync to CloudSyncManager replay when provided", async () => {
    const calls = [];
    const manager = { replayPendingEvents: async () => { calls.push("replay"); return { replayed: 1 }; } };
    const scheduler = new CloudSyncScheduler("machine-1", 15, manager);
    const result = await scheduler.sync();
    expect(result).toEqual({ replayed: 1 });
    expect(calls).toEqual(["replay"]);
  });

  it("returns null when cloud is disabled", async () => {
    const manager = { replayPendingEvents: async () => ({ replayed: 1 }) };
    const scheduler = new CloudSyncScheduler("machine-1", 15, manager);
    mockIsCloudEnabled.mockResolvedValue(false);
    const result = await scheduler.sync();
    expect(result).toBeNull();
  });

  it("setManager updates the manager and sync() uses it", async () => {
    const calls = [];
    const manager1 = { replayPendingEvents: async () => { calls.push("old"); return { replayed: 0 }; } };
    const manager2 = { replayPendingEvents: async () => { calls.push("new"); return { replayed: 1 }; } };
    const scheduler = new CloudSyncScheduler("machine-1", 15, manager1);
    scheduler.setManager(manager2);
    await scheduler.sync();
    expect(calls).toEqual(["new"]);
  });

  it("sync checks isCloudEnabled first", async () => {
    const manager = { replayPendingEvents: async () => ({ replayed: 1 }) };
    const scheduler = new CloudSyncScheduler("machine-1", 15, manager);
    await scheduler.sync();
    expect(mockIsCloudEnabled).toHaveBeenCalled();
  });
});