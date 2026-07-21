import { useEffect, useMemo, useState } from 'react'
import { PageLayout } from '@/components/page-layout'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { CliTerminal } from '@/components/cli-terminal'
import { useSessions } from '@/hooks/use-sessions'
import { groupTerminalsByAgent } from './terminal-sessions'

interface TermSession {
  id: string
  engine?: string
  status?: string
  employee?: string
  title?: string | null
  promptExcerpt?: string | null
  lastActivity?: string
  createdAt?: string
  sessionRole?: string
  lifecycleState?: string | null
}

function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function StatusDot({ status }: { status?: string }) {
  const cls =
    status === 'running'
      ? 'bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite]'
      : status === 'error'
        ? 'bg-[var(--system-red)]'
        : 'bg-[var(--text-quaternary)]'
  return <span className={`size-1.5 shrink-0 rounded-full ${cls}`} />
}

function RailRow({
  s,
  selected,
  onSelect,
  label,
}: {
  s: TermSession
  selected: boolean
  onSelect: (id: string) => void
  label?: string
}) {
  const sub = (label || s.title || s.promptExcerpt || 'Untitled').trim() || 'Untitled'
  return (
    <button
      onClick={() => onSelect(s.id)}
      className={`flex w-full items-center gap-2.5 border-l-2 py-1.5 pl-6 pr-3 text-left transition-colors ${
        selected
          ? 'border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]'
          : 'border-l-transparent hover:bg-[var(--fill-tertiary)]'
      }`}
    >
      <StatusDot status={s.status} />
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
        {sub}
      </span>
    </button>
  )
}

// A list of live agent terminals with one focused, fully-interactive xterm — the
// technical, "in control" view. The friendly chat dashboard stays separate.
export default function TerminalsPage() {
  const { data: rawSessions } = useSessions()
  const groups = useMemo(
    () => groupTerminalsByAgent((rawSessions ?? []) as unknown as TermSession[], { cap: 5 }),
    [rawSessions],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Agents whose task list has been expanded past the cap via "+N more".
  const [revealed, setRevealed] = useState<Set<string>>(new Set())

  // Keep a valid selection: default to the top (running-first) session; re-point
  // if the current one drops out of the list. Candidates include all non-archived
  // tasks (not just the capped slice) so a revealed selection isn't reset.
  useEffect(() => {
    const candidateIds = groups
      .flatMap((g) => [g.home?.id, ...g.tasks.map((t) => t.id)])
      .filter(Boolean) as string[]
    if (candidateIds.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !candidateIds.includes(selectedId)) {
      setSelectedId(candidateIds[0])
    }
  }, [groups, selectedId])

  return (
    <PageLayout>
      <div className="flex h-full min-h-0 bg-[var(--bg)]">
        {/* Rail — list of terminal chats across agents */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--separator)] bg-[var(--sidebar-bg)]">
          <div className="px-4 py-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.4px] text-[var(--text-tertiary)]">
            Terminals
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {groups.every((g) => !g.home && g.visibleTasks.length === 0) ? (
              <div className="px-4 py-6 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
                No CLI-capable agent sessions yet.
              </div>
            ) : (
              groups.map((g) => {
                if (!g.home && g.visibleTasks.length === 0) return null
                const label = g.agent === 'you' ? 'You' : titleCase(g.agent)
                const name = g.agent === 'you' ? 'you' : g.agent
                return (
                  <div key={g.agent} className="pb-1">
                    <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                      <EmployeeAvatar name={name} size={20} />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                        {label}
                      </span>
                      {g.hasRunning ? <StatusDot status="running" /> : null}
                    </div>
                    {g.home ? (
                      <RailRow s={g.home} selected={g.home.id === selectedId} onSelect={setSelectedId} label="💬 Home chat" />
                    ) : null}
                    {(revealed.has(g.agent) ? g.tasks : g.visibleTasks).map((s) => (
                      <RailRow key={s.id} s={s} selected={s.id === selectedId} onSelect={setSelectedId} />
                    ))}
                    {g.hiddenCount > 0 && !revealed.has(g.agent) ? (
                      <button
                        onClick={() => setRevealed((prev) => new Set(prev).add(g.agent))}
                        className="w-full py-1 pl-9 pr-3 text-left text-[length:var(--text-caption2)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
                      >
                        +{g.hiddenCount} more
                      </button>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        </aside>

        {/* Focused, interactive terminal */}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {selectedId ? (
            <CliTerminal key={selectedId} sessionId={selectedId} interactive onForked={setSelectedId} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
              Select an agent terminal
            </div>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
