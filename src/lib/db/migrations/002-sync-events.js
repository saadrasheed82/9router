// Migration 002: Add local sync events queue for cloud sync offline resilience.
import { buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "sync-events",
  up(db) {
    db.exec(buildCreateTableSql("syncEvents", {
      columns: {
        id: "TEXT PRIMARY KEY",
        userId: "TEXT",
        deviceId: "TEXT",
        tableName: "TEXT NOT NULL",
        recordId: "TEXT",
        eventType: "TEXT NOT NULL",
        version: "INTEGER DEFAULT 1",
        payload: "TEXT NOT NULL",
        status: "TEXT NOT NULL DEFAULT 'pending'",
        error: "TEXT",
        createdAt: "TEXT NOT NULL",
        syncedAt: "TEXT",
      },
      indexes: [
        "CREATE INDEX IF NOT EXISTS idx_sync_events_status ON syncEvents(status)",
        "CREATE INDEX IF NOT EXISTS idx_sync_events_created ON syncEvents(createdAt)",
      ],
    }));
  },
};