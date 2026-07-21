# Terminals rail — chat-parity actions + collapse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Terminals rail the chat sidebar's per-session actions (pin / rename / fork / delete) and collapsible agent groups, reusing the same client-side mechanisms.

**Architecture:** A pure grouping-helper change (pinned-first ordering) + UI wiring in the Terminals page that mirrors `chat-sidebar.tsx`'s `SessionRow` (⋯ dropdown + right-click context menu + inline rename) and its delete `Dialog`, reusing `useUpdateSession` / `useDeleteSession` / `useDuplicateSession` and the `jinn-pinned-sessions` localStorage store.

**Tech Stack:** React + Vite, TypeScript, @tanstack/react-query, vitest.

Spec: `docs/superpowers/specs/2026-07-21-terminals-actions-design.md`.

## Global Constraints

- Node **24** (`nvm use 24`); pnpm via corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm ...`).
- **TDD** for the pure helper; UI tasks verify via `typecheck` + `build` (this codebase unit-tests pure helpers, not JSX).
- Verify web: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`.
- Do NOT run `jinn-dev`/`jinn` or touch `~/.jinn`. Branch: `feat/terminals-actions` (already created).
- **Reuse, don't reinvent:** mirror `chat-sidebar.tsx` patterns exactly (same hooks, same localStorage keys where shared, same UI components). Read the referenced chat-sidebar regions COMPLETELY before writing the equivalent.

## File Structure
- `packages/web/src/routes/terminals/terminal-sessions.ts` — add `pinnedIds` to `groupTerminalsByAgent` (pinned-first sort within a group).
- `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts` — pinned-first test.
- `packages/web/src/routes/terminals/page.tsx` — collapse state + collapsed render; pin/rename/delete state; ⋯ dropdown + context menu on each row; inline rename; delete `Dialog`; fork/select wiring.

---

### Task 1: `groupTerminalsByAgent` — pinned-first ordering

**Files:**
- Modify: `packages/web/src/routes/terminals/terminal-sessions.ts`
- Test: `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts`

**Interfaces:**
- Produces: `groupTerminalsByAgent(sessions, opts?: { cap?: number; pinnedIds?: Set<string> })` — when `pinnedIds` is given, tasks whose `id` is pinned sort first within their group (stable: otherwise preserves the existing running-first/activity order). `visibleTasks`/`hiddenCount`/`tasks`/`home`/`hasRunning` semantics unchanged otherwise.

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("groupTerminalsByAgent", ...)`)

```typescript
  it("floats pinned tasks to the top of their group (stable otherwise)", () => {
    const out = groupTerminalsByAgent(
      [
        t("a", "fw", "task", "idle", "3"),
        t("b", "fw", "task", "idle", "2"),
        t("c", "fw", "task", "idle", "1"),
      ],
      { pinnedIds: new Set(["c"]) },
    );
    // "c" is pinned → first; "a","b" keep their activity order after it.
    expect(out[0].tasks.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(out[0].visibleTasks.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("without pinnedIds, ordering is unchanged", () => {
    const out = groupTerminalsByAgent([
      t("a", "fw", "task", "idle", "3"),
      t("b", "fw", "task", "idle", "1"),
    ]);
    expect(out[0].tasks.map((x) => x.id)).toEqual(["a", "b"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: FAIL — pinned task not floated (`["a","b","c"]` or a type error on `pinnedIds`).

- [ ] **Step 3: Implement**

In `groupTerminalsByAgent`, change the opts type to `{ cap?: number; pinnedIds?: Set<string> }`, read `const pinnedIds = opts?.pinnedIds`, and after computing `const tasks = rows.filter(...)`, insert the stable pinned-first sort BEFORE `visibleTasks`/`live` are derived from it. Concretely, replace:

```typescript
    const tasks = rows.filter((r) => r.sessionRole !== 'home' && r.lifecycleState !== 'archived')
    const live = home ? [home, ...tasks] : tasks
```

with:

```typescript
    let tasks = rows.filter((r) => r.sessionRole !== 'home' && r.lifecycleState !== 'archived')
    if (pinnedIds && pinnedIds.size > 0) {
      // Stable sort (ES2019+): pinned ids first, otherwise keep the running-first /
      // activity order selectTerminalSessions already produced.
      tasks = [...tasks].sort((a, b) => (pinnedIds.has(b.id) ? 1 : 0) - (pinnedIds.has(a.id) ? 1 : 0))
    }
    const live = home ? [home, ...tasks] : tasks
```

(and update the function signature's `opts?` type to include `pinnedIds?: Set<string>`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/web/src/routes/terminals/terminal-sessions.ts packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts
git -C /Users/moreira/Development/jinn commit -m "feat(web/terminals): pinned-first ordering in groupTerminalsByAgent"
```

---

### Task 2: Collapsible agent groups

**Files:**
- Modify: `packages/web/src/routes/terminals/page.tsx`

**Interfaces:**
- Consumes: `groups` from `groupTerminalsByAgent`.
- Produces: per-agent collapse state persisted in `localStorage["jinn-terminals-collapsed"]`; a clickable agent header that toggles it; collapsed groups render only their header.

- [ ] **Step 1: Add collapse state + persistence helpers**

At module scope in `page.tsx` (top, after imports):

```typescript
const TERMINALS_COLLAPSE_KEY = 'jinn-terminals-collapsed'

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
```

In `TerminalsPage`, add state + a toggle:

```typescript
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
```

- [ ] **Step 2: Make the agent header a toggle + gate the body on collapse**

In the group render, change the header `<div class="flex items-center gap-2 …">` into a `<button type="button" onClick={() => toggleCollapse(g.agent)}>` with the same layout classes plus `w-full text-left`, and add a chevron indicator (import `ChevronDown` from `lucide-react`) that rotates when collapsed:

```tsx
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
```

Wrap the home row + tasks + "+N more" block in `{!collapsed.has(g.agent) && ( … )}` so a collapsed group shows only its header.

- [ ] **Step 3: Verify (typecheck + build)**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/web/src/routes/terminals/page.tsx
git -C /Users/moreira/Development/jinn commit -m "feat(web/terminals): collapsible agent groups (persisted, terminals-specific)"
```

---

### Task 3: Per-terminal actions — pin / rename / fork / delete

**Files:**
- Modify: `packages/web/src/routes/terminals/page.tsx`

**Reference to mirror (read these COMPLETELY first):**
- `packages/web/src/components/chat/chat-sidebar.tsx` `SessionRow` (~lines 490–615): the inline-rename `<input>`, the hover ⋯ `DropdownMenu` (import from `@/components/ui/dropdown-menu`), and the right-click `ContextMenu` (import from `@/components/ui/context-menu`), with items Pin / Rename / Duplicate / Delete.
- `chat-sidebar.tsx` delete confirm (~lines 1915–1945): a `Dialog` (import from `@/components/ui/dialog`) driven by a `deleteTarget` state.
- Pin store: `PINNED_STORAGE_KEY = "jinn-pinned-sessions"`, `savePinnedSessions`, `togglePin` (~lines 119, 184) — REUSE this exact key so pins are shared with chat.

**Interfaces:**
- Consumes: `useUpdateSession` (`.mutate({ id, data: { title } })`), `useDeleteSession` (`.mutate(id)`), `useDuplicateSession` (`.mutateAsync(id)` → `{ …, id }`), all from `@/hooks/use-sessions`; the `jinn-pinned-sessions` localStorage store; `groupTerminalsByAgent`'s `pinnedIds` (Task 1).
- Produces: each task row gets a ⋯ dropdown + right-click context menu (Pin / Rename / Fork / Delete), inline rename, and a delete confirm `Dialog`. Pinned ids flow into the `groups` memo.

- [ ] **Step 1: Add hooks, pin/rename/delete state, and the pinned-ids memo dep**

In `page.tsx` add the imports (`useUpdateSession`, `useDeleteSession`, `useDuplicateSession` from `@/hooks/use-sessions`; `Pin`, `Pencil`, `Copy`, `Trash2`, `EllipsisVertical` from `lucide-react`; the `DropdownMenu*`, `ContextMenu*`, `Dialog*` components), plus the pin localStorage helpers (copy `PINNED_STORAGE_KEY`/`loadPinned`/`savePinned` mirroring chat-sidebar's `jinn-pinned-sessions` logic — same key). Then in `TerminalsPage`:

```typescript
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
```

Thread pins into grouping — change the `groups` memo to pass `pinnedIds`:

```typescript
  const groups = useMemo(
    () => groupTerminalsByAgent((rawSessions ?? []) as unknown as TermSession[], { cap: 5, pinnedIds: pinned }),
    [rawSessions, pinned],
  )
```

Handlers:

```typescript
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
```

- [ ] **Step 2: Give `RailRow` the actions (mirror `SessionRow`)**

Extend `RailRow`'s props with the handlers + flags it needs: `pinned: boolean`, `renaming: boolean`, `canDelete: boolean` (false for a home row), `onTogglePin`, `onStartRename`, `onCommitRename`, `onFork`, `onRequestDelete`. Render, mirroring `chat-sidebar.tsx`'s `SessionRow`:
- when `renaming`, an inline `<input>` (autofocus, commit on Enter/blur, cancel on Esc) that calls `onCommitRename(value)`;
- otherwise the existing row button, PLUS a hover-revealed `EllipsisVertical` `DropdownMenu` trigger and a wrapping `ContextMenu`, both with items: **Pin/Unpin** (`onTogglePin`), **Rename** (`onStartRename`), **Fork** (`onFork`), and **Delete** (`variant="destructive"`, `onRequestDelete`) — omit Delete when `!canDelete`.

Copy the dropdown/context menu structure and class names from `SessionRow` verbatim (adapt the callbacks). Pass the props from the group render:

```tsx
                        <RailRow
                          key={s.id}
                          s={s}
                          selected={s.id === selectedId}
                          onSelect={setSelectedId}
                          pinned={pinned.has(s.id)}
                          renaming={renamingId === s.id}
                          canDelete
                          onTogglePin={() => togglePin(s.id)}
                          onStartRename={() => setRenamingId(s.id)}
                          onCommitRename={(v) => handleRename(s.id, v)}
                          onFork={() => handleFork(s.id)}
                          onRequestDelete={() => setDeleteTarget({ id: s.id, label: (s.title || s.promptExcerpt || 'Untitled').trim() || 'Untitled' })}
                        />
```

For the home row, pass `canDelete={false}` (and the same other props).

- [ ] **Step 3: Add the delete confirm Dialog**

Near the end of `TerminalsPage`'s returned JSX (as a sibling of the main layout `div`, before `</PageLayout>`), add a `Dialog` mirroring `chat-sidebar.tsx`'s delete dialog:

```tsx
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        {/* DialogContent: title `Delete "${deleteTarget?.label}"?`, body "This permanently
            deletes the session and all its messages. This cannot be undone.", a Cancel
            button (setDeleteTarget(null)) and a destructive Delete button (handleConfirmDelete).
            Copy the DialogContent/Header/Footer structure + classes from chat-sidebar.tsx:1915. */}
      </Dialog>
```

- [ ] **Step 4: Verify (typecheck + build)**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: both clean.

- [ ] **Step 5: Manual check (human — deferred)**

Hover a terminal → ⋯ menu; right-click → context menu. Pin floats it to the top of the group; Rename edits inline; Fork opens a copy; Delete confirms then removes it and re-points selection.

- [ ] **Step 6: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/web/src/routes/terminals/page.tsx
git -C /Users/moreira/Development/jinn commit -m "feat(web/terminals): per-terminal pin/rename/fork/delete (dropdown + context menu)"
```

---

## Self-review notes
- **Spec coverage:** §2.1 collapse → Task 2; §2.2 actions → Task 3; §2.3 pinned-first → Task 1; §2.4 home-vs-task (canDelete flag) → Task 3.
- **Type consistency:** `pinnedIds?: Set<string>` produced by Task 1, consumed by Task 3's `groups` memo; `RailRow` prop additions all supplied at the call sites in Task 3.
- **No placeholders:** deterministic parts (helper, state, handlers, wiring) are complete code; the menu/dialog JSX explicitly points at the exact chat-sidebar reference to mirror (a UI parity task — the implementer must read the reference completely), which is the DRY, faithful approach rather than transcribing ~150 lines of menu markup.
