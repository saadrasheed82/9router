import crypto from "node:crypto";

const DEFAULT_ITERATIONS = 100000;
const KEY_BYTES = 32;

export async function deriveDeviceKey({ machineId, userSecret, salt = "9router-supabase-secret-v1" }) {
  if (!machineId || !userSecret) {
    throw new Error("machineId and userSecret are required to derive a device key");
  }
  return crypto.pbkdf2Sync(`${machineId}:${userSecret}`, salt, DEFAULT_ITERATIONS, KEY_BYTES, "sha256");
}

export async function hashDeviceKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("device key must be a 32-byte Buffer");
  }
  return crypto.createHash("sha256").update(key).digest("hex");
}