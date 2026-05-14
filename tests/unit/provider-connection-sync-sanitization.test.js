/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setCloudSyncManager } from "../../src/lib/db/hooks/cloudSyncHooks.js";

const SENSITIVE_FIELDS = ["apiKey", "accessToken", "refreshToken", "expiresAt", "tokenType"];

function sanitizePayload(payload) {
  const result = { ...payload };
  for (const field of SENSITIVE_FIELDS) {
    if (field in result) result[field] = "[REDACTED]";
  }
  return result;
}

function buildConnectionPayload(conn) {
  return {
    ...conn,
    apiKey: conn.apiKey,
    accessToken: conn.accessToken,
    refreshToken: conn.refreshToken,
    expiresAt: conn.expiresAt,
    tokenType: conn.tokenType,
  };
}

describe("Provider Connection Sync Sanitization", () => {
  let mockManager;
  let capturedEvents;

  beforeEach(() => {
    capturedEvents = [];
    mockManager = {
      pushLocalChange: vi.fn().mockResolvedValue(undefined),
    };
    setCloudSyncManager(mockManager);
  });

  it("sanitizes apiKey from createProviderConnection payload", async () => {
    const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");

    const connData = {
      name: "Test OpenAI",
      provider: "openai",
      type: "api_key",
      apiKey: "sk-secret123",
    };

    await createProviderConnection(connData);

    expect(mockManager.pushLocalChange).toHaveBeenCalled();
    const call = mockManager.pushLocalChange.mock.calls[0][0];
    const payload = call.payload;

    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).not.toHaveProperty("accessToken");
    expect(payload).not.toHaveProperty("refreshToken");
    expect(payload).not.toHaveProperty("expiresAt");
    expect(payload).not.toHaveProperty("tokenType");

    // Non-sensitive fields must still be present
    expect(payload.name).toBe("Test OpenAI");
    expect(payload.provider).toBe("openai");
  });

  it("sanitizes all OAuth fields from createProviderConnection payload", async () => {
    const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");

    const connData = {
      name: "Test Azure",
      provider: "azure",
      type: "oauth",
      apiKey: "azure-key",
      accessToken: "access_secret",
      refreshToken: "refresh_secret",
      expiresAt: "2025-01-01T00:00:00Z",
      tokenType: "Bearer",
    };

    await createProviderConnection(connData);

    expect(mockManager.pushLocalChange).toHaveBeenCalled();
    const call = mockManager.pushLocalChange.mock.calls[0][0];
    const payload = call.payload;

    for (const field of SENSITIVE_FIELDS) {
      expect(payload).not.toHaveProperty(field);
    }

    expect(payload.name).toBe("Test Azure");
    expect(payload.provider).toBe("azure");
  });

  it("sanitizes apiKey from updateProviderConnection result", async () => {
    const { createProviderConnection, updateProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");

    const connData = {
      name: "Update Test",
      provider: "anthropic",
      type: "api_key",
      apiKey: "sk-ant-secret",
    };

    const created = await createProviderConnection(connData);
    mockManager.pushLocalChange.mockClear();

    await updateProviderConnection(created.id, { apiKey: "sk-ant-new-secret" });

    expect(mockManager.pushLocalChange).toHaveBeenCalled();
    const call = mockManager.pushLocalChange.mock.calls[0][0];
    const payload = call.payload;

    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).not.toHaveProperty("accessToken");
    expect(payload).not.toHaveProperty("refreshToken");
    expect(payload).not.toHaveProperty("expiresAt");
    expect(payload).not.toHaveProperty("tokenType");
    expect(payload.name).toBe("Update Test");
  });

  it("deleteProviderConnection syncs DELETE event (no payload sanitization needed)", async () => {
    const { createProviderConnection, deleteProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");

    const connData = {
      name: "Delete Test",
      provider: "google",
      type: "api_key",
      apiKey: "google-key",
    };

    const created = await createProviderConnection(connData);
    mockManager.pushLocalChange.mockClear();

    await deleteProviderConnection(created.id);

    expect(mockManager.pushLocalChange).toHaveBeenCalled();
    const call = mockManager.pushLocalChange.mock.calls[0][0];
    expect(call.eventType).toBe("DELETE");
    expect(call.recordId).toBe(created.id);
  });

  it("setCloudSyncManager(null) prevents sync writes from throwing", async () => {
    setCloudSyncManager(null);
    const { createProviderConnection } = await import("../../src/lib/db/repos/connectionsRepo.js");

    // Should not throw even with no manager
    const connData = {
      name: "No Sync Test",
      provider: "openai",
      type: "api_key",
      apiKey: "sk-secret",
    };

    // Should complete without error
    await expect(createProviderConnection(connData)).resolves.toBeDefined();
  });
});