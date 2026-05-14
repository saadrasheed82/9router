import { LOCAL_TO_SUPABASE_TABLE } from "./tableMap.js";

export function mapLocalTableToSupabase(localTable) {
  const table = LOCAL_TO_SUPABASE_TABLE[localTable];
  if (!table) throw new Error(`No Supabase table mapping for ${localTable}`);
  return table;
}

export function buildSyncEventPayload({ userId, deviceId, localTable, recordId, eventType, version = 1, payload = {} }) {
  if (!userId || !deviceId || !localTable || !eventType) {
    throw new Error("userId, deviceId, localTable, and eventType are required");
  }
  return {
    user_id: userId,
    device_id: deviceId,
    table_name: mapLocalTableToSupabase(localTable),
    record_id: recordId || null,
    event_type: eventType,
    version,
    payload,
  };
}