// CLI-capable engines — keep in sync with CLI_CAPABLE_ENGINES in
// components/chat/chat-pane.tsx (only these expose an interactive PTY view).
// Redefined locally so the Terminals route adds no import edge into chat-pane.tsx
// (keeps this personal feature's upstream edit-surface minimal).
const CLI_CAPABLE_ENGINES = new Set(['claude', 'codex', 'antigravity', 'grok'])

export interface TerminalRailSession {
  engine?: string
  status?: string
  archivedAt?: string | null
  lastActivity?: string
  createdAt?: string
}

const activity = (s: TerminalRailSession) => s.lastActivity || s.createdAt || ''

/**
 * Sessions eligible for the Terminals rail: CLI-capable, non-archived engines,
 * ordered running-first (so what's live floats up) then by most-recent activity.
 * Pure — unit-tested.
 */
export function selectTerminalSessions<T extends TerminalRailSession>(sessions: T[]): T[] {
  return sessions
    .filter((s) => !!s.engine && CLI_CAPABLE_ENGINES.has(s.engine) && !s.archivedAt)
    .slice()
    .sort((a, b) => {
      const ar = a.status === 'running' ? 1 : 0
      const br = b.status === 'running' ? 1 : 0
      if (ar !== br) return br - ar
      return activity(b).localeCompare(activity(a))
    })
}

export interface AgentTerminalGroup<T> {
  agent: string
  /** All non-archived terminals for this agent (uncapped, running-first) — lets
   *  the rail reveal past the cap. */
  tasks: T[]
  visibleTasks: T[]
  hiddenCount: number
  hasRunning: boolean
}

/** Group CLI-capable sessions by agent (employee) for the Terminals rail:
 *  running-first then by activity, capped with a hidden count, pinned ids floated
 *  to the top of their group. Groups with a running session float to the top.
 *  Pure — unit-tested. */
export function groupTerminalsByAgent<
  T extends TerminalRailSession & { id: string; employee?: string },
>(sessions: T[], opts?: { cap?: number; pinnedIds?: Set<string> }): AgentTerminalGroup<T>[] {
  const cap = opts?.cap ?? 5
  const pinnedIds = opts?.pinnedIds
  const filtered = selectTerminalSessions(sessions)
  const byAgent = new Map<string, T[]>()
  for (const s of filtered) {
    const key = s.employee || 'you'
    if (!byAgent.has(key)) byAgent.set(key, [])
    byAgent.get(key)!.push(s)
  }
  const groups: AgentTerminalGroup<T>[] = []
  for (const [agent, rows] of byAgent) {
    let tasks = rows
    if (pinnedIds && pinnedIds.size > 0) {
      // Stable sort (ES2019+): pinned ids first, otherwise keep the running-first /
      // activity order selectTerminalSessions already produced.
      tasks = [...tasks].sort((a, b) => (pinnedIds.has(b.id) ? 1 : 0) - (pinnedIds.has(a.id) ? 1 : 0))
    }
    groups.push({
      agent,
      tasks,
      visibleTasks: tasks.slice(0, cap),
      hiddenCount: Math.max(0, tasks.length - cap),
      hasRunning: tasks.some((r) => r.status === 'running'),
    })
  }
  const groupActivity = (g: AgentTerminalGroup<T>) => {
    const top = g.visibleTasks[0]
    return top ? activity(top) : ''
  }
  groups.sort((a, b) => {
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1
    return groupActivity(b).localeCompare(groupActivity(a))
  })
  return groups
}
