// Kanban board types

export type TicketStatus =
  | 'backlog'
  | 'ready'
  | 'backlog-week-goal'
  | 'in-progress'
  | 'in-review'
  | 'backlog-testing'
  | 'testing'
  | 'ready-to-release'
  | 'done'

export type TicketPriority = 'low' | 'medium' | 'high'

export type WorkState = 'idle' | 'starting' | 'working' | 'done' | 'failed'

export interface KanbanTicket {
  id: string
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  assigneeId: string | null // employee name from /api/org
  department: string | null // department for API persistence
  workState: WorkState
  createdAt: number
  updatedAt: number
  /** The department this ticket belongs to; null for tickets not yet saved to any department */
  departmentId: string | null
  /** GitHub Projects v2 draft-item node id, once synced. Absent = never pushed. */
  githubItemId?: string
  /** ms timestamp of the last successful reconcile for this ticket. */
  githubSyncedAt?: number
}

export interface KanbanColumn {
  id: TicketStatus
  title: string
}

export const COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'backlog-week-goal', title: 'Backlog | Week Goal (Onboarding Offline)' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'in-review', title: 'In review' },
  { id: 'backlog-testing', title: 'Backlog | Testing' },
  { id: 'testing', title: 'Testing' },
  { id: 'ready-to-release', title: 'Ready to release' },
  { id: 'done', title: 'Done' },
]

/** Legacy 5-column statuses → new slug (applied once on load). */
export const LEGACY_STATUS_MIGRATION: Record<string, TicketStatus> = {
  backlog: 'backlog',
  todo: 'ready',
  'in-progress': 'in-progress',
  in_progress: 'in-progress',
  review: 'in-review',
  done: 'done',
}

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'var(--system-green)',
  medium: 'var(--system-orange)',
  high: 'var(--system-red)',
}
