import { describe, it, expect } from "vitest";
import {
  mergeLocalProviderConnectionData,
  mapLocalProviderConnectionToSupabaseRow,
} from "../../src/lib/cloudSync/providerConnectionSyncMap.js";

describe("providerConnectionSyncMap", () => {
  it("mergeLocalProviderConnectionData maps Supabase columns into local JSON data", () => {
    const existing = JSON.stringify({ globalPriority: 2, lastTested: "2024-01-01" });
    const supabaseRow = {
      provider_specific_data: { baseUrl: "https://api.example" },
      test_status: "success",
      last_error: null,
      rate_limited_until: "2026-01-01T00:00:00.000Z",
    };
    const merged = JSON.parse(mergeLocalProviderConnectionData(existing, supabaseRow));
    expect(merged.globalPriority).toBe(2);
    expect(merged.lastTested).toBe("2024-01-01");
    expect(merged.providerSpecificData).toEqual({ baseUrl: "https://api.example" });
    expect(merged.testStatus).toBe("success");
    expect(merged.lastError).toBe(null);
    expect(merged.rateLimitedUntil).toBe("2026-01-01T00:00:00.000Z");
  });

  it("mergeLocalProviderConnectionData accepts camelCase realtime keys", () => {
    const merged = JSON.parse(
      mergeLocalProviderConnectionData("{}", {
        providerSpecificData: { a: 1 },
        testStatus: "error",
      }),
    );
    expect(merged.providerSpecificData).toEqual({ a: 1 });
    expect(merged.testStatus).toBe("error");
  });

  it("mapLocalProviderConnectionToSupabaseRow produces snake_case columns", () => {
    const row = mapLocalProviderConnectionToSupabaseRow(
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        provider: "openai",
        authType: "apikey",
        name: "Main",
        email: null,
        priority: 1,
        isActive: true,
        testStatus: "success",
        lastError: "oops",
        rateLimitedUntil: null,
        providerSpecificData: { x: 1 },
      },
      { userId: "u1", deviceId: "d1", version: 99 },
    );
    expect(row.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(row.user_id).toBe("u1");
    expect(row.device_id).toBe("d1");
    expect(row.auth_type).toBe("apikey");
    expect(row.is_active).toBe(true);
    expect(row.test_status).toBe("success");
    expect(row.last_error).toBe("oops");
    expect(row.provider_specific_data).toEqual({ x: 1 });
    expect(row.version).toBe(99);
  });
});
