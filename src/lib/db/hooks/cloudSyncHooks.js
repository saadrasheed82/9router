let manager = null;

export function setCloudSyncManager(nextManager) {
  manager = nextManager;
}

export function getCloudSyncManager() {
  return manager;
}

export async function mirrorLocalWrite(change) {
  if (!manager) return { skipped: true, reason: "no_manager" };
  try {
    return await manager.pushLocalChange(change);
  } catch (error) {
    console.error("[cloudSync] failed to mirror local write:", error.message);
    return { skipped: true, reason: "push_failed", error: error.message };
  }
}