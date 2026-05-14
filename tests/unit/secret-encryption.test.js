import { describe, it, expect } from "vitest";
import { deriveDeviceKey, hashDeviceKey } from "../../src/lib/crypto/keyDerive.js";
import { encryptSecretPayload, decryptSecretPayload } from "../../src/lib/crypto/secretEncrypt.js";

describe("secret encryption", () => {
  it("round-trips a provider credential payload", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const encrypted = await encryptSecretPayload({
      key,
      payload: { accessToken: "access", refreshToken: "refresh", expiresAt: "2026-05-14T00:00:00.000Z" },
    });

    expect(encrypted).toMatch(/^v1:/);

    const decrypted = await decryptSecretPayload({ key, encryptedPayload: encrypted });
    expect(decrypted).toEqual({ accessToken: "access", refreshToken: "refresh", expiresAt: "2026-05-14T00:00:00.000Z" });
  });

  it("rejects tampered payloads", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const encrypted = await encryptSecretPayload({ key, payload: { apiKey: "secret" } });
    const tampered = encrypted.slice(0, -4) + "AAAA";

    await expect(decryptSecretPayload({ key, encryptedPayload: tampered })).rejects.toThrow("Failed to decrypt secret payload");
  });

  it("hashes a derived key without exposing key material", async () => {
    const key = await deriveDeviceKey({ machineId: "machine-1", userSecret: "passphrase" });
    const hash = await hashDeviceKey(key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("passphrase");
  });
});