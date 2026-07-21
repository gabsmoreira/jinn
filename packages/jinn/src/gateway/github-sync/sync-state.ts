import fs from "node:fs"
import path from "node:path"
import { KANBAN_SYNC_STATE } from "../../shared/paths.js"
import { logger } from "../../shared/logger.js"

export interface SyncState {
  /** GitHub item ids linked to a local ticket as of the last reconcile. */
  linkedItemIds: string[]
  /** Tombstones for items deleted from GitHub due to a local delete. */
  deletedItemIds: string[]
  lastPollAt: number | null
  lastError: string | null
}

function defaults(): SyncState {
  return { linkedItemIds: [], deletedItemIds: [], lastPollAt: null, lastError: null }
}

export function loadSyncState(): SyncState {
  let raw: string
  try {
    raw = fs.readFileSync(KANBAN_SYNC_STATE, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`Failed to read sync-state: ${err instanceof Error ? err.message : err}`)
    }
    return defaults()
  }
  try {
    return { ...defaults(), ...(JSON.parse(raw) as Partial<SyncState>) }
  } catch (err) {
    const backup = `${KANBAN_SYNC_STATE}.corrupt-${Date.now()}`
    try { fs.copyFileSync(KANBAN_SYNC_STATE, backup) } catch { /* best effort */ }
    logger.error(`Corrupt sync-state; backed up to ${backup}, starting fresh.`)
    return defaults()
  }
}

export function saveSyncState(state: SyncState): void {
  fs.mkdirSync(path.dirname(KANBAN_SYNC_STATE), { recursive: true })
  const tmp = `${KANBAN_SYNC_STATE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, KANBAN_SYNC_STATE)
}

/**
 * Resets sync-state to its defaults. Must be called on (re)connect and on
 * department change: linkedItemIds/deletedItemIds are scoped to whichever
 * GitHub Project the engine was last reconciling against. Carrying stale
 * linkedItemIds into a new connection/department would make the engine's
 * remote-only pass treat every item in the new board as "previously linked
 * but now absent locally" and delete it.
 */
export function resetSyncState(): void {
  saveSyncState(defaults())
}
