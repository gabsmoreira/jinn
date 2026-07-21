import type { BoardItem, RemoteItem } from "./types.js"

export function msOf(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

export function statusOptionIdForItem(
  item: BoardItem,
  statusOptionIds: Record<string, string>,
): string | null {
  return statusOptionIds[item.status] ?? null
}

export function slugForOptionId(
  optionId: string | null,
  statusOptionIds: Record<string, string>,
): string {
  if (!optionId) return "backlog"
  for (const [slug, id] of Object.entries(statusOptionIds)) {
    if (id === optionId) return slug
  }
  return "backlog"
}

export function resolveConflict(
  item: BoardItem,
  remote: RemoteItem,
  syncedAt: number,
): "push" | "pull" | "noop" {
  const localChanged = msOf(item.updatedAt) > syncedAt
  const remoteChanged = remote.updatedAtMs > syncedAt
  if (localChanged && remoteChanged) {
    return msOf(item.updatedAt) >= remote.updatedAtMs ? "push" : "pull"
  }
  if (localChanged) return "push"
  if (remoteChanged) return "pull"
  return "noop"
}

export function applyRemoteToItem(
  item: BoardItem,
  remote: RemoteItem,
  statusOptionIds: Record<string, string>,
  nowIso: string,
): BoardItem {
  return {
    ...item,
    title: remote.title,
    description: remote.body,
    status: slugForOptionId(remote.statusOptionId, statusOptionIds),
    // Display-only GitHub → Jinn: surface the GitHub assignee when present, but
    // don't wipe an existing local assignee just because GitHub has none.
    assignee: remote.assignee ?? item.assignee,
    updatedAt: nowIso,
    githubSyncedAt: msOf(nowIso),
  }
}

export function remoteToNewItem(
  remote: RemoteItem,
  statusOptionIds: Record<string, string>,
  id: string,
  nowIso: string,
): BoardItem {
  return {
    id,
    title: remote.title,
    description: remote.body,
    status: slugForOptionId(remote.statusOptionId, statusOptionIds),
    priority: "medium",
    assignee: remote.assignee ?? undefined,
    createdAt: nowIso,
    updatedAt: nowIso,
    githubItemId: remote.itemId,
    githubSyncedAt: msOf(nowIso),
  }
}
