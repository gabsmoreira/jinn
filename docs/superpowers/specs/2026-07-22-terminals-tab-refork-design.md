# Terminals Tab (refork) + Sustainable Fork Maintenance — Design

**Date:** 2026-07-22
**Branch base:** `refork/phase-a` (upstream jinn + the ported bg-agent resume guard)
**Status:** approved (design gate)

## Context

Our fork fell 396 commits behind upstream, which rewrote the PTY layer, router, and
chat surface. A merge would produce a broken hybrid, so we are **not** migrating the
whole fork. Instead we re-apply only the personal features we actually want, on top of
the upstream base, structured so future upstream syncs stay cheap.

Two deliverables:

1. **A sustainable fork-maintenance model** — so pulling upstream updates does not
   keep breaking our personal changes.
2. **The Terminals tab**, rebuilt lean on the upstream base — a personal feature
   (not a PR upstream): an agent-grouped, collapsible rail of CLI terminal sessions
   with per-terminal pin/rename/fork/delete and an embedded live terminal view.

The user is a firmware/software engineer; the Terminals tab is a personal overview /
management surface they want to keep, carried privately on the fork.

## Part 1 — Sustainable fork maintenance

### The failure we are fixing

Upstream moves fast and rewrites shared files. Personal changes that **edit** those
files conflict on every sync. The fix is to make each personal feature a thin,
replayable layer: **new files plus tiny append-only seams**, so a sync is a clean
rebase, not a merge war.

### The model

1. **A long-lived `personal` branch = `upstream/main` + a small ordered stack of our
   commits.** Sync = `git fetch upstream && git rebase upstream/main personal`.
2. **Feature logic lives in new files** upstream never touches — those files cannot
   conflict.
3. **The only edits to upstream files are append-style seams** (one nav entry, one
   route entry). Append edits are the least conflict-prone; re-applying a conflicted
   append is seconds.
4. **Zero backend surface where avoidable.** Pin + collapse live in `localStorage`;
   grouping/filter/hide come from columns upstream already has (`employee`, `engine`,
   `archived_at`). No DB columns, no migrations, no gateway edits.
5. **Reuse shared primitives, don't fork them** — existing hooks and `CliTerminal`.
6. **Tests guard the rebase** — the ported grouping helper test, a terminals render
   test, and the existing bg-agent tests fail loudly if a sync breaks something.

### Current personal layer (maintenance cost, ranked)

| Feature | Files edited (shared) | New files | Cost on sync |
|---|---|---|---|
| bg-agent resume guard (Phase A, shipped) | `claude-interactive.ts`, `pty-ws.ts`, `pty-view-engine.ts`, `pty-stream.ts`, `cli-terminal.tsx`, `chat-pane.tsx` | `bg-agent-guard.ts` + tests | **High** — deep engine seams |
| Terminals tab (this) | `nav.ts` (+1), `main.tsx` (+2) | `routes/terminals/*` + test | **Low** — append seams only |

The Terminals tab is the model to aim for; the bg-agent guard is the piece most likely
to need touch-ups on a big upstream sync.

### Sync runbook (deliverable: `docs/FORK-MAINTENANCE.md`)

Documented, repeatable steps:

```
git fetch upstream
git rebase upstream/main personal      # replays our commit stack onto new upstream
# resolve only the ~3 seam lines if they conflict (nav.ts / main.tsx)
pnpm install
pnpm -C packages/jinn build && pnpm -C packages/web build
pnpm -C packages/jinn test && pnpm -C packages/web test   # bg-agent + terminals guard
```

The doc also records: the seam locations (so a conflict is obvious), the list of
personal commits, and the "new files over edits" rule for anything added later.

> Note: establishing the `personal` branch and writing `FORK-MAINTENANCE.md` is part of
> this work, but the day-to-day branch mechanics (fetch/rebase) are operational, not code
> to test. The plan covers writing the doc; the branch itself is created at finish time.

## Part 2 — The Terminals tab

### Behavior

- **Agent-grouped rail** on the left: sessions grouped by `employee` (fallback `"you"`),
  filtered to CLI-capable engines, archived sessions excluded.
- **Collapse/expand per agent group** — click the group header to toggle; state persists
  in `localStorage`. (The specific ask.)
- **Per-terminal actions** via dropdown + right-click context menu: **pin, rename, fork
  (duplicate), delete** — mirroring the chat rail.
- **Cap + "+N more"** — show the first N tasks per group; click "+N more" to reveal the
  rest.
- **Embedded terminal**: the selected session renders in `CliTerminal` (upstream's,
  verbatim) — watch live output, send control keys (Enter / Ctrl-C / arrows). Free-text
  typing is **out of scope** (see below); it already carries the bg-agent Fork/Retry
  panel from Phase A.

### Architecture — new files (never conflict)

- `packages/web/src/routes/terminals/terminal-sessions.ts` — **pure helpers**, no React,
  no I/O:
  - `selectTerminalSessions(sessions)` — filter to CLI-capable engines
    (`claude`, `codex`, `antigravity`, `grok`; defined locally to avoid editing
    `chat-pane.tsx`), exclude archived (`archived_at != null`), sort running-first then
    by `lastActivity`/`createdAt` desc.
  - `groupTerminalsByAgent(sessions, { pinnedIds, cap })` — bucket by `employee`
    (`"you"` fallback), pinned-first stable sort within a bucket, `visibleTasks =
    slice(0, cap)`, `hiddenCount`, `hasRunning`; group order = running groups first then
    by group activity. **No `home`/`session_role`/`lifecycleState` dependency** — grouping
    is purely on `employee` + `status` + `archived_at`.
- `packages/web/src/routes/terminals/page.tsx` — default-exported `TerminalsPage`:
  - `useSessions()` → `selectTerminalSessions` → `groupTerminalsByAgent`.
  - Rail: group header (chevron + `EmployeeAvatar` + label + status dot, click toggles
    collapse), one `RailRow` per visible task, "+N more" button.
  - `RailRow`: dropdown + context menu (Pin/Rename/Fork/Delete), inline rename `<input>`,
    status dot.
  - Delete confirm `Dialog`.
  - Main pane: `<CliTerminal key={selectedId} sessionId={selectedId} onForked={setSelectedId} />`.
  - `pinned: Set<string>` in `localStorage["jinn-pinned-sessions"]` (same key the chat
    rail uses — pins stay in sync). `collapsed: Set<string>` in
    `localStorage["jinn-terminals-collapsed"]`. Both local-only; never sent to backend.
  - Selection effect: recompute candidate ids from the **uncapped** tasks, re-point
    `selectedId` when the current selection disappears.
- `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts` — unit tests
  for both pure helpers.

### Architecture — seam edits (3 lines, append-style)

- `packages/web/src/lib/nav.ts` — add one `BASE_NAV_ITEMS` entry
  `{ href: "/terminals", label: "Terminals", icon: SquareTerminal }` (from `lucide-react`).
  Because `primaryHrefs` is a fixed allowlist, this auto-appears in the desktop rail
  popover and the mobile `/more` overflow with no further edits.
- `packages/web/src/main.tsx` — add one lazy import
  `const TerminalsPage = lazyRoute(() => import('./routes/terminals/page'), 'terminals')`
  and one child route `{ path: '/terminals', element: <TerminalsPage /> }`.

### Data model — reuse only, nothing new

All mutations use existing hooks (`packages/web/src/hooks/use-sessions.ts`), unmodified:

| Action | Hook | Endpoint |
|---|---|---|
| Rename | `useUpdateSession()` `{title}` | `PUT /api/sessions/:id` |
| Fork | `useDuplicateSession()` | `POST /api/sessions/:id/duplicate` |
| Delete | `useDeleteSession()` | `DELETE /api/sessions/:id` |
| List | `useSessions()` | `GET /api/sessions` |

Pin + collapse are `localStorage`-only. **No registry columns, no migration, no gateway
change.**

### Import-path adaptations (upstream vs. dev)

- `EmployeeAvatar` is at `@/components/ui/employee-avatar` upstream (was
  `@/components/employee-avatar` on dev).
- `CLI_CAPABLE_ENGINES` is module-private in `chat-pane.tsx`; **redefine it locally** in
  `terminal-sessions.ts` (a copy with a `// keep in sync with chat-pane.tsx` comment) to
  avoid a third seam edit.
- Confirm `page-layout` / `useBreadcrumbs` usage matches an existing upstream route
  (e.g. `routes/more/page.tsx`) and follow that shape.

### Testing

- **Pure helpers** (`terminal-sessions.test.ts`): filtering (non-CLI + archived
  excluded), running-first sort, employee bucketing + `"you"` fallback, pinned-first
  stable order, cap/`hiddenCount`, `hasRunning` excludes archived, group ordering.
- **Page smoke test** (optional, if it fits the upstream test harness): renders
  `TerminalsPage` with a mocked `useSessions`, asserts groups render and a collapse
  toggle hides/shows rows. Only if the harness supports it cheaply; the pure-helper tests
  are the required coverage.

## Out of scope (explicitly)

- **Free-text interactive typing** into terminals — deferred. Would require an
  `interactive` prop on the shared `CliTerminal` plus a raw-stdin fix so keystrokes don't
  auto-submit; a deeper, higher-maintenance seam. Can be an isolated follow-on.
- **Home-chat / task model** (`session_role`, `lifecycle_state`, `getOrCreateHomeChat`,
  `brief`/`outcome`) — dropped. It had no live caller on dev and would drag in
  `registry.ts`/`types.ts` edits. Upstream has its own task primitives; not adopting them
  here.
- **Kanban autonomous execution** (worktree agents) — separate future project.
- **Full upstream migration** of all dev features — not doing it.

## Success criteria

- A `/terminals` route + nav entry that lists CLI sessions grouped by agent.
- Each group collapses/expands (persisted) on header click.
- Each row supports pin/rename/fork/delete; selecting a row shows its live terminal.
- The feature is 2 new files + a 3-line append seam + `FORK-MAINTENANCE.md`; no backend
  changes.
- Pure-helper tests pass; typecheck + web build clean.
- A documented sync runbook exists so future upstream pulls rebase cleanly.
