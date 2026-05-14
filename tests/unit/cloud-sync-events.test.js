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