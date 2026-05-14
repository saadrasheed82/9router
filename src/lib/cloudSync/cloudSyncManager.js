import { buildSyncEventPayload, mapLocalTableToSupabase } from "./syncEvents.js";

export class CloudSyncManager {
  constructor({ supabase, enabled = false, userId = null, deviceId = null, localStore = null } = {}) {
    this.supabase = supabase;
    this.enabled = enabled;
    this.userId = userId;
    this.deviceId = deviceId;
    this.localStore = localStore;
    this.channels = [];
  }

  isReady() {
    return Boolean(this.enabled && this.supabase && this.userId && this.deviceId);
  }

  async pushLocalChange({ localTable, recordId, eventType, version = 1, payload = {} }) {
    if (!this.enabled) return { skipped: true, reason: "disabled" };
    if (!this.isReady()) return { skipped: true, reason: "not_ready" };

    const syncEvent = buildSyncEventPayload({
      userId: this.userId,
      deviceId: this.deviceId,
      localTable,
      recordId,
      eventType,
      version,
      payload,
    });

    const syncInsert = await this.supabase.from("sync_events").insert(syncEvent);
    if (syncInsert.error) throw syncInsert.error;

    const table = mapLocalTableToSupabase(localTable);
    if (eventType === "DELETE") {
      const softDelete = await this.supabase
        .from(table)
        .upsert({ id: recordId, user_id: this.userId, device_id: this.deviceId, deleted_at: new Date().toISOString(), version });
      if (softDelete.error) throw softDelete.error;
      return { pushed: true };
    }

    const row = {
      ...payload,
      user_id: payload.user_id || this.userId,
      device_id: payload.device_id === undefined ? this.deviceId : payload.device_id,
      version,
    };
    const upsert = await this.supabase.from(table).upsert(row);
    if (upsert.error) throw upsert.error;
    return { pushed: true };
  }

  subscribeToUserTables({ tables, onChange }) {
    if (!this.isReady()) return [];
    this.channels = tables.map((table) => {
      const channel = this.supabase
        .channel(`9router:${this.userId}:${table}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `user_id=eq.${this.userId}` },
          (payload) => onChange({ table, payload })
        )
        .subscribe();
      return channel;
    });
    return this.channels;
  }

  async replayPendingEvents() {
    if (!this.isReady()) return { replayed: 0, failed: 0 };
    if (!this.localStore?.getPendingEvents) return { replayed: 0, failed: 0 };

    const events = await this.localStore.getPendingEvents();
    let replayed = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await this.pushLocalChange(event);
        await this.localStore.markSynced(event.id);
        replayed++;
      } catch (error) {
        failed++;
        if (this.localStore.markFailed) await this.localStore.markFailed(event.id, error.message);
      }
    }
    return { replayed, failed };
  }

  async stop() {
    for (const channel of this.channels) {
      if (this.supabase?.removeChannel) await this.supabase.removeChannel(channel);
    }
    this.channels = [];
  }
}