// CLI-capable engines — keep in sync with CLI_CAPABLE_ENGINES in
// components/chat/chat-pane.tsx (only these expose an interactive PTY view).
const CLI_CAPABLE_ENGINES = new Set(['claude', 'codex', 'antigravity', 'grok'])

export interface TerminalRailSession {
  engine?: string
  status?: string
  lastActivity?: string
  createdAt?: string
}

/**
 * Sessions eligible for the Terminals rail: CLI-capable engines only, ordered
 * running-first (so what's live floats to the top) then by most-recent activity.
 * Pure — drives the rail and is unit-tested.
 */
export function selectTerminalSessions<T extends TerminalRailSession>(sessions: T[]): T[] {
  const activity = (s: T) => s.lastActivity || s.createdAt || ''
  return sessions
    .filter((s) => !!s.engine && CLI_CAPABLE_ENGINES.has(s.engine))
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
  home: T | null
  /** All non-archived tasks (uncapped, running-first) — lets the rail reveal past the cap. */
  tasks: T[]
  visibleTasks: T[]
  hiddenCount: number
  hasRunning: boolean
}

/** Group CLI-capable sessions by agent for the Terminals+ rail: home chat pinned,
 *  non-archived tasks running-first then by activity, capped with a hidden count.
 *  Groups with a running (non-archived) session float to the top. Pure — unit-tested. */
export function groupTerminalsByAgent<
  T extends TerminalRailSession & { id: string; employee?: string; sessionRole?: string; lifecycleState?: string | null },
>(sessions: T[], opts?: { cap?: number }): AgentTerminalGroup<T>[] {
  const cap = opts?.cap ?? 5
  const filtered = selectTerminalSessions(sessions)
  const byAgent = new Map<string, T[]>()
  for (const s of filtered) {
    const key = s.employee || 'you'
    if (!byAgent.has(key)) byAgent.set(key, [])
    byAgent.get(key)!.push(s)
  }
  const groups: AgentTerminalGroup<T>[] = []
  for (const [agent, rows] of byAgent) {
    const home = rows.find((r) => r.sessionRole === 'home') ?? null
    const tasks = rows.filter((r) => r.sessionRole !== 'home' && r.lifecycleState !== 'archived')
    const live = home ? [home, ...tasks] : tasks
    groups.push({
      agent,
      home,
      tasks,
      visibleTasks: tasks.slice(0, cap),
      hiddenCount: Math.max(0, tasks.length - cap),
      hasRunning: live.some((r) => r.status === 'running'),
    })
  }
  const activity = (g: AgentTerminalGroup<T>) =>
    g.home?.lastActivity || g.visibleTasks[0]?.lastActivity || ''
  groups.sort((a, b) => {
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1
    return activity(b).localeCompare(activity(a))
  })
  return groups
}
