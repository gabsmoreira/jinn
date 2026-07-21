export interface BoardItem {
  id: string
  title: string
  description?: string
  status: string
  priority: string
  assignee?: string
  createdAt: string
  updatedAt: string
  githubItemId?: string
  githubSyncedAt?: number
}

export interface RemoteItem {
  itemId: string
  draftId: string | null
  title: string
  body: string
  statusOptionId: string | null
  updatedAtMs: number
  /** Comma-joined GitHub assignee login(s) for display in Jinn; null if unassigned. Read-only (never pushed). */
  assignee: string | null
}

export interface ReconcileSummary {
  created: number
  updated: number
  imported: number
  deleted: number
  error?: string
}
