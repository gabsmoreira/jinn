import { useEffect, useMemo, useState } from 'react'
import { PageLayout } from '@/components/page-layout'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { CliTerminal } from '@/components/cli-terminal'
import { useSessions } from '@/hooks/use-sessions'
import { selectTerminalSessions } from './terminal-sessions'

interface TermSession {
  id: string
  engine?: string
  status?: string
  employee?: string | null
  title?: string | null
  promptExcerpt?: string | null
  lastActivity?: string
  createdAt?: string
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

// A list of live agent terminals with one focused, fully-interactive xterm — the
// technical, "in control" view. The friendly chat dashboard stays separate.
export default function TerminalsPage() {
  const { data: rawSessions } = useSessions()
  const sessions = useMemo(
    () => selectTerminalSessions((rawSessions ?? []) as unknown as TermSession[]),
    [rawSessions],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Keep a valid selection: default to the top (running-first) session; re-point
  // if the current one drops out of the list.
  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !sessions.some((s) => s.id === selectedId)) {
      setSelectedId(sessions[0].id)
    }
  }, [sessions, selectedId])

  return (
    <PageLayout>
      <div className="flex h-full min-h-0 bg-[var(--bg)]">
        {/* Rail — list of terminal chats across agents */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--separator)] bg-[var(--sidebar-bg)]">
          <div className="px-4 py-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.4px] text-[var(--text-tertiary)]">
            Terminals
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {sessions.length === 0 ? (
              <div className="px-4 py-6 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
                No CLI-capable agent sessions yet.
              </div>
            ) : (
              sessions.map((s) => {
                const name = s.employee || 'you'
                const label = s.employee ? titleCase(s.employee) : 'You'
                const sub = (s.title || s.promptExcerpt || 'Untitled').trim() || 'Untitled'
                const active = s.id === selectedId
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`flex w-full items-center gap-2.5 border-l-2 px-3 py-2 text-left transition-colors ${
                      active
                        ? 'border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]'
                        : 'border-l-transparent hover:bg-[var(--fill-tertiary)]'
                    }`}
                  >
                    <EmployeeAvatar name={name} size={22} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <StatusDot status={s.status} />
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                          {label}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        {sub}
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        {/* Focused, interactive terminal */}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {selectedId ? (
            <CliTerminal key={selectedId} sessionId={selectedId} interactive />
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
