import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";

/**
 * Maps Supabase `provider_connections` row fields into the camelCase keys stored
 * inside local SQLite's JSON `data` column (see connectionsRepo.connToRow).
 */
export function mergeLocalProviderConnectionData(existingDataStr, newRec) {
  const base = parseJson(existingDataStr, {}) || {};
  if (!newRec || typeof newRec !== "object") return stringifyJson(base);

  const patch = {};
  if ("provider_specific_data" in newRec || "providerSpecificData" in newRec) {
    const psd = "provider_specific_data" in newRec
      ? newRec.provider_specific_data
      : newRec.providerSpecificData;
    patch.providerSpecificData = psd == null ? {} : psd;
  }
  if ("test_status" in newRec || "testStatus" in newRec) {
    patch.testStatus = "test_status" in newRec ? newRec.test_status : newRec.testStatus;
  }
  if ("last_error" in newRec || "lastError" in newRec) {
    patch.lastError = "last_error" in newRec ? newRec.last_error : newRec.lastError;
  }
  if ("rate_limited_until" in newRec || "rateLimitedUntil" in newRec) {
    patch.rateLimitedUntil = "rate_limited_until" in newRec
      ? newRec.rate_limited_until
      : newRec.rateLimitedUntil;
  }

  return stringifyJson({ ...base, ...patch });
}

/**
 * Maps a flat local connection object to Supabase `provider_connections` columns.
 * Omits secrets (already stripped before mirrorLocalWrite).
 */
export function mapLocalProviderConnectionToSupabaseRow(local, { userId, deviceId, version }) {
  if (!local?.id || !local?.provider) {
    throw new Error("mapLocalProviderConnectionToSupabaseRow: id and provider are required");
  }
  const authType = local.authType ?? local.auth_type ?? "oauth";
  const isActive = local.isActive !== false && local.is_active !== false;

  const test_status = "testStatus" in local
    ? local.testStatus
    : ("test_status" in local ? local.test_status : null);
  const last_error = "lastError" in local
    ? local.lastError
    : ("last_error" in local ? local.last_error : null);
  const rate_limited_until = "rateLimitedUntil" in local
    ? local.rateLimitedUntil
    : ("rate_limited_until" in local ? local.rate_limited_until : null);

  let provider_specific_data = {};
  if ("providerSpecificData" in local) {
    const raw = local.providerSpecificData;
    provider_specific_data = raw != null && typeof raw === "object" ? raw : {};
  } else if ("provider_specific_data" in local) {
    const raw = local.provider_specific_data;
    provider_specific_data = raw != null && typeof raw === "object" ? raw : {};
  }

  return {
    id: local.id,
    user_id: local.user_id ?? userId,
    device_id: local.device_id ?? deviceId ?? null,
    provider: local.provider,
    auth_type: authType,
    name: local.name ?? null,
    email: local.email ?? null,
    priority: local.priority ?? null,
    is_active: isActive,
    test_status,
    last_error,
    rate_limited_until,
    provider_specific_data,
    version: version ?? local.version ?? 1,
  };
}
