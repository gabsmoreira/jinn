# Terminals Tab (refork) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a personal, sustainable Terminals tab to the upstream-based fork — an
agent-grouped, collapsible rail of CLI terminal sessions with per-terminal
pin/rename/fork/delete and an embedded (watch + control-keys) terminal view — plus a
fork-maintenance runbook.

**Architecture:** Two new files under `packages/web/src/routes/terminals/` (a pure
grouping helper + the page), a 3-line append seam (`nav.ts` + `main.tsx`), and a docs
runbook. Grouping is derived entirely from existing serialized session fields
(`employee`, `engine`, `status`, `archivedAt`); pin/collapse live in `localStorage`.
No gateway, schema, or shared-component changes. The embedded terminal reuses upstream's
`CliTerminal` verbatim.

**Tech Stack:** React 19 + react-router-dom, @tanstack/react-query, Tailwind (CSS vars),
shadcn/radix UI primitives, xterm.js (inside `CliTerminal`), vitest + @testing-library/react.

## Global Constraints

- **Branch:** work on `refork/phase-a` (the personal branch base). Do NOT touch `dev`.
- **No new backend/schema/gateway code.** Reuse existing hooks and endpoints only.
  Pin + collapse are `localStorage`-only.
- **Minimal upstream edit-surface:** the ONLY edits to pre-existing upstream files are
  one `nav.ts` entry and one `main.tsx` import + route. Everything else is new files.
- **Serialized session field names (camelCase, from `serializeSession`):** `id`,
  `engine`, `status` (`"idle"|"running"|"error"|"waiting"|"interrupted"`), `employee`
  (`string|null`), `title` (`string|null`), `promptExcerpt` (`string|null`),
  `lastActivity` (`string`), `createdAt` (`string`), `archivedAt` (`string|null`).
- **CLI-capable engines:** `claude`, `codex`, `antigravity`, `grok` (redefine locally;
  do NOT import from `chat-pane.tsx`).
- **Terminal input scope:** reuse `CliTerminal` as-is — it has props
  `{ sessionId: string; onForked?: (id: string) => void }` and NO `interactive` prop.
  Do not add one; do not touch the engines' `writeStdin`.
- **Data safety (subagents):** NEVER run destructive commands against `~/.jinn` or any
  real data. These are web-only tests (no DB); if you ever see unexpected real data,
  STOP and report — do not delete/clean up.
- **Verify commands** (run from repo root `/Users/moreira/Development/jinn`):
  ```bash
  export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  corepack pnpm -C packages/web exec vitest run <testfile>
  corepack pnpm -C packages/web typecheck
  corepack pnpm -C packages/web build
  ```
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## File Structure

- Create: `packages/web/src/routes/terminals/terminal-sessions.ts` — pure select/group helpers.
- Create: `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts` — helper unit tests.
- Create: `packages/web/src/routes/terminals/page.tsx` — `TerminalsPage` (default export).
- Create: `packages/web/src/routes/terminals/__tests__/page.test.tsx` — page smoke test.
- Modify: `packages/web/src/lib/nav.ts` — add `SquareTerminal` import + one `BASE_NAV_ITEMS` entry.
- Modify: `packages/web/src/main.tsx` — add one `lazyRoute` import + one route entry.
- Create: `docs/FORK-MAINTENANCE.md` — the sync runbook.

---

### Task 1: Pure grouping helpers (`terminal-sessions.ts`)

Strict TDD. Pure functions, no React/DOM/I/O — the testable core of the rail.

**Files:**
- Create: `packages/web/src/routes/terminals/terminal-sessions.ts`
- Test: `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `interface TerminalRailSession { engine?: string; status?: string; archivedAt?: string | null; lastActivity?: string; createdAt?: string }`
  - `selectTerminalSessions<T extends TerminalRailSession>(sessions: T[]): T[]`
  - `interface AgentTerminalGroup<T> { agent: string; tasks: T[]; visibleTasks: T[]; hiddenCount: number; hasRunning: boolean }`
  - `groupTerminalsByAgent<T extends TerminalRailSession & { id: string; employee?: string }>(sessions: T[], opts?: { cap?: number; pinnedIds?: Set<string> }): AgentTerminalGroup<T>[]`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { selectTerminalSessions, groupTerminalsByAgent } from '../terminal-sessions'

const s = (id: string, engine: string | undefined, status: string, lastActivity: string) =>
  ({ id, engine, status, lastActivity })

describe('selectTerminalSessions', () => {
  it('keeps only CLI-capable engines (claude/codex/antigravity/grok)', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '3'),
      s('b', 'pi', 'idle', '2'),
      s('c', 'codex', 'idle', '1'),
      s('d', 'hermes', 'idle', '4'),
      s('e', 'grok', 'idle', '0'),
    ])
    expect(out.map((x) => x.id).sort()).toEqual(['a', 'c', 'e'])
  })

  it('excludes archived sessions', () => {
    const out = selectTerminalSessions([
      { id: 'a', engine: 'claude', status: 'idle', lastActivity: '2' },
      { id: 'b', engine: 'claude', status: 'idle', lastActivity: '1', archivedAt: '2026-01-01' },
    ])
    expect(out.map((x) => x.id)).toEqual(['a'])
  })

  it('orders running sessions first', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '5'),
      s('b', 'claude', 'running', '1'),
      s('c', 'codex', 'idle', '3'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'a', 'c'])
  })

  it('within a run-state group, orders by most-recent activity', () => {
    const out = selectTerminalSessions([
      s('a', 'claude', 'idle', '1'),
      s('b', 'claude', 'idle', '3'),
      s('c', 'claude', 'idle', '2'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('falls back to createdAt when lastActivity is missing', () => {
    const out = selectTerminalSessions([
      { id: 'a', engine: 'claude', status: 'idle', createdAt: '1' },
      { id: 'b', engine: 'claude', status: 'idle', createdAt: '2' },
    ])
    expect(out.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('drops sessions with no engine', () => {
    const out = selectTerminalSessions([
      { id: 'a', status: 'idle', lastActivity: '1' },
      s('b', 'claude', 'idle', '2'),
    ])
    expect(out.map((x) => x.id)).toEqual(['b'])
  })
})

const t = (id: string, employee: string | undefined, status: string, act: string, archivedAt?: string) =>
  ({ id, engine: 'claude', employee, status, lastActivity: act, archivedAt })

describe('groupTerminalsByAgent', () => {
  it('groups by agent (employee), running-first within a group', () => {
    const out = groupTerminalsByAgent([
      t('task-run', 'fw', 'running', '1'),
      t('task-old', 'fw', 'idle', '5'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].agent).toBe('fw')
    expect(out[0].visibleTasks.map((x) => x.id)).toEqual(['task-run', 'task-old'])
    expect(out[0].hasRunning).toBe(true)
  })

  it('excludes archived sessions from groups', () => {
    const out = groupTerminalsByAgent([
      t('live', 'fw', 'idle', '1'),
      t('arch', 'fw', 'idle', '8', '2026-01-01'),
    ])
    expect(out[0].tasks.map((x) => x.id)).toEqual(['live'])
  })

  it('caps visible tasks and reports hiddenCount (full list retained)', () => {
    const many = Array.from({ length: 8 }, (_, i) => t(`x${i}`, 'fw', 'idle', String(8 - i)))
    const out = groupTerminalsByAgent(many, { cap: 5 })
    expect(out[0].visibleTasks).toHaveLength(5)
    expect(out[0].hiddenCount).toBe(3)
    expect(out[0].tasks).toHaveLength(8)
  })

  it("buckets sessions with no employee under 'you' and floats running groups first", () => {
    const out = groupTerminalsByAgent([
      t('a', 'fw', 'idle', '1'),
      t('b', undefined, 'running', '2'),
    ])
    expect(out.map((g) => g.agent)).toEqual(['you', 'fw'])
  })

  it('orders non-running groups by group-level activity', () => {
    const out = groupTerminalsByAgent([
      t('a1', 'fw', 'idle', '1'),
      t('b1', 'hvac', 'idle', '5'),
    ])
    expect(out.map((g) => g.agent)).toEqual(['hvac', 'fw'])
  })

  it('hasRunning ignores archived sessions', () => {
    const out = groupTerminalsByAgent([
      t('arch-run', 'fw', 'running', '9', '2026-01-01'),
      t('live', 'fw', 'idle', '1'),
    ])
    expect(out[0].hasRunning).toBe(false)
  })

  it('floats pinned tasks to the top of their group (stable otherwise)', () => {
    const out = groupTerminalsByAgent(
      [
        t('a', 'fw', 'idle', '3'),
        t('b', 'fw', 'idle', '2'),
        t('c', 'fw', 'idle', '1'),
      ],
      { pinnedIds: new Set(['c']) },
    )
    expect(out[0].tasks.map((x) => x.id)).toEqual(['c', 'a', 'b'])
    expect(out[0].visibleTasks.map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('without pinnedIds, ordering is unchanged', () => {
    const out = groupTerminalsByAgent([
      t('a', 'fw', 'idle', '3'),
      t('b', 'fw', 'idle', '1'),
    ])
    expect(out[0].tasks.map((x) => x.id)).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: FAIL — `Failed to resolve import '../terminal-sessions'` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/routes/terminals/terminal-sessions.ts`:

```ts
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

/**
 * Sessions eligible for the Terminals rail: CLI-capable, non-archived engines,
 * ordered running-first (so what's live floats up) then by most-recent activity.
 * Pure — unit-tested.
 */
export function selectTerminalSessions<T extends TerminalRailSession>(sessions: T[]): T[] {
  const activity = (s: T) => s.lastActivity || s.createdAt || ''
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
  const activity = (g: AgentTerminalGroup<T>) => g.visibleTasks[0]?.lastActivity || ''
  groups.sort((a, b) => {
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1
    return activity(b).localeCompare(activity(a))
  })
  return groups
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: PASS — all `selectTerminalSessions` and `groupTerminalsByAgent` cases green.

- [ ] **Step 5: Typecheck**

Run: `corepack pnpm -C packages/web typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/terminals/terminal-sessions.ts \
        packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts
git commit -m "feat(web/terminals): pure select/group helpers (employee-grouped, archived-aware)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Terminals page + nav/route seams (`page.tsx`)

Port the page (lean: no home/task-model, no `interactive` prop), wire the route and nav
entry, and add a render smoke test. This is a UI port from a known-good source, so the
full file is given verbatim below and the smoke test follows the implementation (it
characterizes the rendered rail + collapse; the driving logic was TDD'd in Task 1).

**Files:**
- Create: `packages/web/src/routes/terminals/page.tsx`
- Create: `packages/web/src/routes/terminals/__tests__/page.test.tsx`
- Modify: `packages/web/src/lib/nav.ts`
- Modify: `packages/web/src/main.tsx`

**Interfaces:**
- Consumes: `groupTerminalsByAgent` from `./terminal-sessions` (Task 1); `useSessions`,
  `useUpdateSession`, `useDeleteSession`, `useDuplicateSession` from `@/hooks/use-sessions`;
  `CliTerminal` from `@/components/cli-terminal` (props `{ sessionId; onForked? }`);
  `PageLayout`, `EmployeeAvatar`, and the `ui/{context-menu,dropdown-menu,dialog,button}`
  primitives.
- Produces: default-exported `TerminalsPage` component at route `/terminals`.

- [ ] **Step 1: Create the page**

Create `packages/web/src/routes/terminals/page.tsx`:

```tsx
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
    deleteSession.mutate(id)
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
```

- [ ] **Step 2: Add the nav entry (`nav.ts`)**

In `packages/web/src/lib/nav.ts`, add `SquareTerminal` to the `lucide-react` import
(after `NotebookPen,`):

```ts
  MoreHorizontal,
  NotebookPen,
  SquareTerminal,
} from "lucide-react"
```

Then add one entry to `BASE_NAV_ITEMS`, immediately after the `/skills` line:

```ts
  { href: "/skills", label: "Skills", icon: Zap },
  { href: "/terminals", label: "Terminals", icon: SquareTerminal },
  { href: "/settings", label: "Settings", icon: Settings },
```

(No other edits — `/terminals` is not in `primaryHrefs`, so it lands in the desktop
overflow popover and the mobile `/more` screen automatically.)

- [ ] **Step 3: Add the route (`main.tsx`)**

In `packages/web/src/main.tsx`, add the lazy import after the `WorkflowPage` line (25):

```ts
const TerminalsPage = lazyRoute(() => import('./routes/terminals/page'), 'terminals')
```

Then add the route inside the `children` array, immediately after the `/more` entry:

```ts
      { path: '/more', element: <MorePage /> },
      { path: '/terminals', element: <TerminalsPage /> },
```

- [ ] **Step 4: Write the smoke test**

Create `packages/web/src/routes/terminals/__tests__/page.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the shell + heavy children so the page renders in isolation.
vi.mock('@/components/page-layout', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/cli-terminal', () => ({ CliTerminal: () => <div data-testid="cli" /> }))
vi.mock('@/components/ui/employee-avatar', () => ({ EmployeeAvatar: () => <div /> }))
vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({
    data: [
      { id: 's1', engine: 'claude', status: 'running', employee: 'fw', title: 'Build firmware', lastActivity: '2' },
      { id: 's2', engine: 'claude', status: 'idle', employee: 'fw', title: 'Refactor', lastActivity: '1' },
    ],
  }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutate: vi.fn() }),
  useDuplicateSession: () => ({ mutateAsync: vi.fn() }),
}))

import TerminalsPage from '../page'

describe('TerminalsPage', () => {
  beforeEach(() => localStorage.clear())

  it('renders an agent group with its terminal rows', () => {
    render(<TerminalsPage />)
    expect(screen.getByText('Fw')).toBeTruthy()
    expect(screen.getByText('Build firmware')).toBeTruthy()
    expect(screen.getByText('Refactor')).toBeTruthy()
  })

  it('collapses a group to just its header when the header is clicked', () => {
    render(<TerminalsPage />)
    expect(screen.getByText('Refactor')).toBeTruthy()
    fireEvent.click(screen.getByText('Fw'))
    expect(screen.queryByText('Refactor')).toBeNull()
  })
})
```

- [ ] **Step 5: Run the smoke test**

Run: `corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/page.test.tsx`
Expected: PASS — both tests green (rows render; clicking the header hides them).

- [ ] **Step 6: Typecheck + build**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: no type errors; production build succeeds (route chunk `terminals` emitted).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/routes/terminals/page.tsx \
        packages/web/src/routes/terminals/__tests__/page.test.tsx \
        packages/web/src/lib/nav.ts packages/web/src/main.tsx
git commit -m "feat(web/terminals): agent-grouped Terminals tab with collapse + row actions

New route /terminals + nav entry. Grouped-by-agent rail, collapse/expand
(persisted), pin/rename/fork/delete via existing hooks, embedded CliTerminal
(watch + control keys). No backend changes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fork-maintenance runbook (`docs/FORK-MAINTENANCE.md`)

The sustainability deliverable — a documented, repeatable upstream-sync process. Docs
only; no test.

**Files:**
- Create: `docs/FORK-MAINTENANCE.md`

- [ ] **Step 1: Create the doc**

Create `docs/FORK-MAINTENANCE.md`:

```markdown
# Fork maintenance — keeping personal features across upstream syncs

This fork carries a few **personal** features on top of upstream jinn that we do NOT
upstream via PR. Upstream moves fast and rewrites shared files, so personal changes are
structured as a thin, replayable layer: **new files + tiny append-only seams**. Syncing
upstream is then a clean rebase, not a merge war.

## The model

- `personal` branch = `upstream/main` + a small ordered stack of our commits.
- Feature logic lives in **new files** upstream never touches (cannot conflict).
- The only edits to upstream files are **append-style seams** (one nav entry, one route
  entry) — the least conflict-prone edit; re-applying a conflict is seconds.
- **No backend surface** where avoidable — pin/collapse in localStorage; grouping from
  existing columns (`employee`, `engine`, `archivedAt`).
- Reuse shared primitives (hooks, `CliTerminal`), don't fork them.
- Tests guard the rebase.

## Personal features (the commit stack)

| Feature | New files | Seam edits (upstream files) |
|---|---|---|
| bg-agent resume guard | `packages/jinn/src/engines/bg-agent-guard.ts` (+ tests) | `claude-interactive.ts`, `pty-ws.ts`, `pty-view-engine.ts`, `pty-stream.ts`, `cli-terminal.tsx`, `chat-pane.tsx` |
| Terminals tab | `packages/web/src/routes/terminals/*` (+ tests) | `packages/web/src/lib/nav.ts` (+1 nav entry), `packages/web/src/main.tsx` (+1 import, +1 route) |

The Terminals tab is the low-cost model; the bg-agent guard is the piece most likely to
need touch-ups on a large upstream sync (deep engine seams).

## Sync runbook

```bash
git fetch upstream
git rebase upstream/main personal          # replay our commit stack onto new upstream

# Resolve conflicts — expect them ONLY at the seams:
#   packages/web/src/lib/nav.ts   → re-add the { href: "/terminals", ... } entry
#   packages/web/src/main.tsx     → re-add the TerminalsPage import + route
#   (bg-agent) engine/pty files   → re-apply the guard hooks if the PTY layer moved

# Rebuild + test
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm -C packages/jinn build && corepack pnpm -C packages/web build
corepack pnpm -C packages/jinn test && corepack pnpm -C packages/web test
```

If the terminals helper test or the bg-agent tests fail after a rebase, the sync moved
something the feature depends on — fix before continuing.

## Adding new personal features later

Follow the same rule: **new files, minimal append seams, no backend if you can avoid it,
add a test.** Keep the commit small and well-labeled so it rebases cleanly. Update the
table above.
```

- [ ] **Step 2: Commit**

```bash
git add docs/FORK-MAINTENANCE.md
git commit -m "docs: fork-maintenance runbook (sustainable upstream syncs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** grouped rail (Task 1 helper + Task 2 render), collapse/expand
  persisted (Task 2), pin/rename/fork/delete (Task 2), cap + "+N more" (Task 1/2),
  archived hidden (Task 1), embedded CliTerminal verbatim (Task 2), 3-line seam (Task 2),
  no backend (whole plan), sustainability runbook (Task 3). All covered.
- **Placeholder scan:** none — every step has full code/commands/expected output.
- **Type consistency:** `groupTerminalsByAgent`/`selectTerminalSessions`/`AgentTerminalGroup`
  signatures identical in Task 1's Interfaces block, its implementation, and Task 2's
  consumption. `TermSession` in `page.tsx` is a structural superset of `TerminalRailSession
  & { id; employee }`, so the `as unknown as TermSession[]` cast + helper call typecheck.
  Field names match the Global Constraints (camelCase, `archivedAt`).
- **Out-of-scope guards:** no `interactive` prop on `CliTerminal`; no engine `writeStdin`
  edits; no home/task-model columns; no `Button` `ref`/`onOpenAutoFocus` (upstream Button
  is not a forwardRef).
