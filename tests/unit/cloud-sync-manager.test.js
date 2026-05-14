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
});