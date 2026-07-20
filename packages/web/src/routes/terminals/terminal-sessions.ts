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
