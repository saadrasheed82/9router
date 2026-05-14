import crypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export async function encryptSecretPayload({ key, payload }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("device key must be a 32-byte Buffer");
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  const plaintext = Buffer.from(JSON.stringify(payload || {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export async function decryptSecretPayload({ key, encryptedPayload }) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error("device key must be a 32-byte Buffer");
    }
    const [version, ivB64, tagB64, ciphertextB64] = String(encryptedPayload || "").split(":");
    if (version !== VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
      throw new Error("invalid encrypted payload format");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Failed to decrypt secret payload");
  }
}