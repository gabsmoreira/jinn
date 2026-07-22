import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, EllipsisVertical, Pencil, Pin, Trash2 } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { CliTerminal } from '@/components/cli-terminal'
import { useSessions, useUpdateSession, useDeleteSession, useDuplicateSession } from '@/hooks/use-sessions'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { groupTerminalsByAgent } from './terminal-sessions'

const TERMINALS_COLLAPSE_KEY = 'jinn-terminals-collapsed'
// Same key chat-sidebar.tsx uses (PINNED_STORAGE_KEY) — pins are shared across
// the Terminals rail and the chat sidebar.
const PINNED_STORAGE_KEY = 'jinn-pinned-sessions'

function loadCollapsed(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(TERMINALS_COLLAPSE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsed(collapsed: Set<string>) {
  try {
    localStorage.setItem(TERMINALS_COLLAPSE_KEY, JSON.stringify(Array.from(collapsed)))
  } catch {
    /* ignore */
  }
}

function loadPinned(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

function savePinned(pinned: Set<string>) {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(pinned)))
  } catch {
    /* ignore */
  }
}

interface TermSession {
  id: string
  engine?: string
  status?: string
  employee?: string
  title?: string | null
  promptExcerpt?: string | null
  lastActivity?: string
  createdAt?: string
  archivedAt?: string | null
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
  pinned,
  renaming,
  onTogglePin,
  onStartRename,
  onCommitRename,
  onFork,
  onRequestDelete,
}: {
  s: TermSession
  selected: boolean
  onSelect: (id: string) => void
  pinned: boolean
  renaming: boolean
  onTogglePin: () => void
  onStartRename: () => void
  onCommitRename: (title: string) => void
  onFork: () => void
  onRequestDelete: () => void
}) {
  const sub = (s.title || s.promptExcerpt || 'Untitled').trim() || 'Untitled'
  const renameSeed = sub
  // Scoped to this row — guards the Escape-then-blur sequence so blur doesn't
  // re-commit after a cancelled rename (mirrors chat-sidebar's renameCancelledRef).
  const renameCancelledRef = useRef(false)
  const RowTag = renaming ? 'div' : 'button'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowTag
          {...(!renaming && { onClick: () => onSelect(s.id) })}
          className={`group/term relative flex w-full items-center gap-2.5 border-l-2 py-1.5 pl-6 pr-3 text-left transition-colors ${
            selected
              ? 'border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]'
              : 'border-l-transparent hover:bg-[var(--fill-tertiary)]'
          }`}
        >
          <StatusDot status={s.status} />
          {renaming ? (
            <input
              autoFocus
              maxLength={200}
              defaultValue={renameSeed}
              className="min-w-0 flex-1 truncate rounded border-none bg-transparent px-0.5 text-[length:var(--text-caption1)] text-[var(--text-secondary)] outline-none ring-1 ring-[var(--text-quaternary)]"
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  renameCancelledRef.current = true
                  onCommitRename('')
                }
              }}
              onBlur={(e) => {
                if (renameCancelledRef.current) {
                  renameCancelledRef.current = false
                  return
                }
                onCommitRename(e.target.value)
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              {sub}
            </span>
          )}
          {pinned ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] group-hover/term:lg:opacity-0 group-has-[[data-state=open]]/term:lg:opacity-0" />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                aria-label="Terminal actions"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:invisible group-hover/term:lg:visible group-has-[[data-state=open]]/term:lg:visible"
              >
                <EllipsisVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { renameCancelledRef.current = false; onStartRename() }}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onTogglePin}>
                <Pin /> {pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onFork}>
                <Copy /> Fork
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onRequestDelete}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </RowTag>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => { renameCancelledRef.current = false; onStartRename() }}>
          <Pencil /> Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={onTogglePin}>
          <Pin /> {pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <ContextMenuItem onClick={onFork}>
          <Copy /> Fork
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onRequestDelete}>
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// A list of live agent terminals grouped by agent, with one focused xterm view
// (watch + control keys — reuses the shared CliTerminal). The friendly chat
// dashboard stays separate.
export default function TerminalsPage() {
  const { data: rawSessions } = useSessions()
  const updateSession = useUpdateSession()
  const deleteSession = useDeleteSession()
  const duplicate = useDuplicateSession()
  const [pinned, setPinned] = useState<Set<string>>(() => loadPinned())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      savePinned(next)
      return next
    })
  }

  const groups = useMemo(
    () => groupTerminalsByAgent((rawSessions ?? []) as unknown as TermSession[], { cap: 5, pinnedIds: pinned }),
    [rawSessions, pinned],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Agents whose task list has been expanded past the cap via "+N more".
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  // Agents whose group is collapsed to just the header — persisted across reloads.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed())
  const toggleCollapse = (agent: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(agent)) next.delete(agent)
      else next.add(agent)
      saveCollapsed(next)
      return next
    })
  }

  const handleRename = (id: string, title: string) => {
    const t = title.trim()
    if (t) updateSession.mutate({ id, data: { title: t } })
    setRenamingId(null)
  }
  const handleFork = async (id: string) => {
    try {
      const res = await duplicate.mutateAsync(id)
      const newId = (res as any)?.session?.id ?? (res as any)?.id
      if (newId) setSelectedId(newId)
    } catch (err) {
      window.alert(`Fork failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const handleConfirmDelete = () => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    deleteSession.mutate(id, {
      onError: (err) => window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`),
    })
    if (selectedId === id) setSelectedId(null)
    setDeleteTarget(null)
  }

  // Keep a valid selection: default to the top (running-first) session; re-point
  // if the current one drops out. Candidates include the full (uncapped) task list
  // so a revealed-past-cap selection isn't reset.
  useEffect(() => {
    const candidateIds = groups.flatMap((g) => g.tasks.map((task) => task.id))
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
        {/* Rail — terminals grouped by agent */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--separator)] bg-[var(--sidebar-bg)]">
          <div className="px-4 py-3 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.4px] text-[var(--text-tertiary)]">
            Terminals
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {groups.every((g) => g.visibleTasks.length === 0) ? (
              <div className="px-4 py-6 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
                No CLI-capable agent sessions yet.
              </div>
            ) : (
              groups.map((g) => {
                if (g.visibleTasks.length === 0) return null
                const label = g.agent === 'you' ? 'You' : titleCase(g.agent)
                const name = g.agent === 'you' ? 'you' : g.agent
                return (
                  <div key={g.agent} className="pb-1">
                    <button
                      type="button"
                      onClick={() => toggleCollapse(g.agent)}
                      className="flex w-full items-center gap-2 px-3 pt-3 pb-1 text-left"
                    >
                      <ChevronDown
                        className={`size-3 shrink-0 text-[var(--text-tertiary)] transition-transform ${collapsed.has(g.agent) ? '-rotate-90' : ''}`}
                      />
                      <EmployeeAvatar name={name} size={20} />
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
                        {label}
                      </span>
                      {g.hasRunning ? <StatusDot status="running" /> : null}
                    </button>
                    {!collapsed.has(g.agent) && (
                      <>
                        {(revealed.has(g.agent) ? g.tasks : g.visibleTasks).map((s) => (
                          <RailRow
                            key={s.id}
                            s={s}
                            selected={s.id === selectedId}
                            onSelect={setSelectedId}
                            pinned={pinned.has(s.id)}
                            renaming={renamingId === s.id}
                            onTogglePin={() => togglePin(s.id)}
                            onStartRename={() => setRenamingId(s.id)}
                            onCommitRename={(v) => handleRename(s.id, v)}
                            onFork={() => handleFork(s.id)}
                            onRequestDelete={() =>
                              setDeleteTarget({ id: s.id, label: (s.title || s.promptExcerpt || 'Untitled').trim() || 'Untitled' })
                            }
                          />
                        ))}
                        {g.hiddenCount > 0 && !revealed.has(g.agent) ? (
                          <button
                            onClick={() => setRevealed((prev) => new Set(prev).add(g.agent))}
                            className="w-full py-1 pl-9 pr-3 text-left text-[length:var(--text-caption2)] text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
                          >
                            +{g.hiddenCount} more
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </aside>

        {/* Focused terminal — watch + control keys (reuses upstream CliTerminal) */}
        <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {selectedId ? (
            <CliTerminal key={selectedId} sessionId={selectedId} onForked={setSelectedId} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
              Select an agent terminal
            </div>
          )}
        </main>
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{`Delete "${deleteTarget?.label}"?`}</DialogTitle>
            <DialogDescription>
              This permanently deletes the session and all its messages. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  )
}
