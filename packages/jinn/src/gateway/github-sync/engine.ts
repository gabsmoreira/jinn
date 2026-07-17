import { randomUUID } from "node:crypto"
import type { JinnConfig } from "../../shared/types.js"
import { logger } from "../../shared/logger.js"
import { readBoard, writeBoard } from "./board-io.js"
import { loadSyncState, saveSyncState } from "./sync-state.js"
import type { GithubClient } from "./gql-client.js"
import { createGithubClient } from "./gql-client.js"
import type { BoardItem, ReconcileSummary } from "./types.js"
import {
  statusOptionIdForItem, resolveConflict, applyRemoteToItem, remoteToNewItem, msOf,
} from "./mapping.js"

type Github = NonNullable<JinnConfig["github"]>

export interface ReconcileDeps {
  client: GithubClient
  github: Github
  nowIso: string
  newId: () => string
  emit?: (event: string, payload: unknown) => void
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { client, github, nowIso, newId, emit } = deps
  const summary: ReconcileSummary = { created: 0, updated: 0, imported: 0, deleted: 0 }
  const state = loadSyncState()
  const optionIds = github.statusOptionIds ?? {}
  const fieldId = github.statusFieldId ?? ""

  try {
    const remote = await client.listItems(github.projectId)
    const remoteById = new Map(remote.map((r) => [r.itemId, r]))
    const local = readBoard(github.department)
    const nextLocal: BoardItem[] = []

    // Local-side pass: linked / local-only / delete-remote.
    for (const item of local) {
      if (item.githubItemId) {
        const match = remoteById.get(item.githubItemId)
        if (!match) {
          // Linked item vanished from GitHub → delete locally.
          summary.deleted++
          continue
        }
        remoteById.delete(item.githubItemId) // consumed; leftover = remote-only
        const decision = resolveConflict(item, match, item.githubSyncedAt ?? 0)
        if (decision === "push") {
          if (match.draftId) await client.updateDraft(match.draftId, item.title, item.description ?? "")
          const optId = statusOptionIdForItem(item, optionIds)
          if (optId && fieldId) await client.setStatus(github.projectId, item.githubItemId, fieldId, optId)
          summary.updated++
          nextLocal.push({ ...item, githubSyncedAt: msOf(nowIso) })
        } else if (decision === "pull") {
          summary.updated++
          nextLocal.push(applyRemoteToItem(item, match, optionIds, nowIso))
        } else {
          nextLocal.push(item)
        }
      } else {
        // Local-only → create draft on GitHub.
        const itemId = await client.createDraft(github.projectId, item.title, item.description ?? "")
        const optId = statusOptionIdForItem(item, optionIds)
        if (optId && fieldId) await client.setStatus(github.projectId, itemId, fieldId, optId)
        summary.created++
        nextLocal.push({ ...item, githubItemId: itemId, githubSyncedAt: msOf(nowIso) })
      }
    }

    // Remote-only pass. A leftover remote item is one of:
    //   • tombstoned            → skip
    //   • previously linked here → the local ticket was deleted in Jinn → delete on GitHub
    //   • genuinely new          → import as a new local ticket
    const tombstones = new Set(state.deletedItemIds)
    const previouslyLinked = new Set(state.linkedItemIds)
    const newTombstones = [...state.deletedItemIds]
    for (const r of remoteById.values()) {
      if (tombstones.has(r.itemId)) continue
      if (previouslyLinked.has(r.itemId)) {
        await client.deleteItem(github.projectId, r.itemId)
        newTombstones.push(r.itemId)
        summary.deleted++
        continue
      }
      nextLocal.push(remoteToNewItem(r, optionIds, newId(), nowIso))
      summary.imported++
    }

    writeBoard(github.department, nextLocal)
    const linkedItemIds = nextLocal
      .map((i) => i.githubItemId)
      .filter((id): id is string => Boolean(id))
    saveSyncState({
      linkedItemIds,
      deletedItemIds: newTombstones,
      lastPollAt: msOf(nowIso),
      lastError: null,
    })
    if (summary.deleted || summary.imported || summary.updated || summary.created) {
      emit?.("board:updated", { department: github.department })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.error = message
    saveSyncState({ ...state, lastError: message })
    logger.error(`GitHub sync reconcile failed: ${message}`)
  }
  return summary
}

// ---- Singleton loop control ----

let timer: NodeJS.Timeout | null = null
let running = false
let rerun = false
let debounce: NodeJS.Timeout | null = null
let currentGetConfig: (() => JinnConfig) | null = null
let currentEmit: ((event: string, payload: unknown) => void) | undefined

function activeGithub(getConfig: () => JinnConfig): Github | null {
  const g = getConfig().github
  if (!g || !g.enabled || !g.token || !g.projectId) return null
  return g
}

async function runOnce(): Promise<ReconcileSummary> {
  if (!currentGetConfig) return { created: 0, updated: 0, imported: 0, deleted: 0 }
  const github = activeGithub(currentGetConfig)
  if (!github) return { created: 0, updated: 0, imported: 0, deleted: 0 }
  if (running) { rerun = true; return { created: 0, updated: 0, imported: 0, deleted: 0 } }
  running = true
  try {
    const client = createGithubClient(github.token)
    return await reconcile({
      client, github, nowIso: new Date().toISOString(), newId: () => randomUUID(), emit: currentEmit,
    })
  } finally {
    running = false
    if (rerun) { rerun = false; void runOnce() }
  }
}

export function startGithubSync(getConfig: () => JinnConfig, emit: (event: string, payload: unknown) => void): void {
  currentGetConfig = getConfig
  currentEmit = emit
  const github = activeGithub(getConfig)
  if (!github) { logger.info("GitHub kanban sync: disabled (no config)"); return }
  const intervalMs = Math.max(15, github.pollIntervalSec ?? 45) * 1000
  logger.info(`GitHub kanban sync: polling every ${intervalMs / 1000}s for department "${github.department}"`)
  void runOnce()
  timer = setInterval(() => void runOnce(), intervalMs)
}

export function stopGithubSync(): void {
  if (timer) clearInterval(timer)
  if (debounce) clearTimeout(debounce)
  timer = null; debounce = null; running = false; rerun = false
}

export function reloadGithubSync(getConfig: () => JinnConfig, emit: (event: string, payload: unknown) => void): void {
  stopGithubSync()
  startGithubSync(getConfig, emit)
}

export function notifyBoardChange(department: string): void {
  if (!currentGetConfig) return
  const github = activeGithub(currentGetConfig)
  if (!github || github.department !== department) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { debounce = null; void runOnce() }, 2000)
}

export async function syncNow(): Promise<ReconcileSummary> {
  return runOnce()
}
