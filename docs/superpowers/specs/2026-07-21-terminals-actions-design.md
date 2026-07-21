# Design: Terminals rail — chat-parity actions + collapse

- **Date:** 2026-07-21
- **Status:** Design approved — implementation to follow
- **Branch:** `feat/terminals-actions`

## 1. Problem

The Terminals rail (`packages/web/src/routes/terminals/page.tsx`) lists agent-grouped
terminals but, unlike the chat sidebar, offers no per-session actions (pin / rename /
fork / delete) and no collapsible agent groups. Bring it to parity with the chat
sidebar, reusing the same client-side mechanisms and endpoints.

## 2. Design

All client-side; no backend changes (reuses existing hooks + endpoints).

### 2.1 Collapsible agent groups
- Clicking an agent header toggles collapse. Collapsed = just the header (avatar,
  name, live count + status dot); expanded = header + home + tasks (current behavior).
- Persisted in a **terminals-specific** localStorage key `jinn-terminals-collapsed`
  (independent of the chat sidebar's `jinn-sidebar-collapsed`).

### 2.2 Per-terminal actions (hover ⋯ dropdown + right-click context menu)
Mirror the chat sidebar's `SessionRow`: each terminal row exposes a hover **⋯**
`DropdownMenu` and a right-click `ContextMenu`, both with:
- **Pin** — reuses the chat pin store (`jinn-pinned-sessions` localStorage +
  `togglePin`), keyed by session id, so a pin is consistent across chat + terminals.
  Pinned terminals float to the top of their agent group.
- **Rename** — inline title edit; commits via `useUpdateSession` (`updateSessionTitle`).
- **Fork (Duplicate)** — `useDuplicateSession`; on success selects the new session
  (via the page's `setSelectedId`), matching the chat "Duplicate…" action.
- **Delete** — opens a confirm `AlertDialog`; on confirm calls `useDeleteSession` and
  re-points the selection if the deleted terminal was selected.

### 2.3 Ordering
`groupTerminalsByAgent` gains an optional `pinnedIds: Set<string>` param and sorts
**pinned tasks first** within each group (then the existing running-first / activity
order). Pure — unit-tested.

### 2.4 Row-type rules
- **Task rows:** all four actions.
- **Home-chat rows** (once Phase 1b creates them): **Rename + Fork**, but **no Delete**
  (the home chat is the persistent per-agent thread). No home rows exist yet, so today
  every actionable row is a task.

## 3. Data / API
No new endpoints or backend changes. Reuses `useUpdateSession`, `useDeleteSession`,
`useDuplicateSession`, the `jinn-pinned-sessions` localStorage store, and the shared
`DropdownMenu` / `ContextMenu` / `AlertDialog` UI components.

## 4. Non-goals
- Bulk actions / multi-select (chat has some; out of scope here).
- Employee-group-level pin/delete (chat's `emp:` pin key) — terminals pin individual
  sessions only.
- Server-persisted pins (stays localStorage, matching chat).

## 5. Testing strategy
- Pure-helper TDD: `groupTerminalsByAgent` sorts pinned tasks first within a group
  (and leaves home pinned above all, cap/hiddenCount unaffected).
- Collapse + actions UI: typecheck + build (this codebase unit-tests the pure helpers,
  not JSX).

## 6. Files
- `packages/web/src/routes/terminals/terminal-sessions.ts` — `pinnedIds` sort in
  `groupTerminalsByAgent`.
- `packages/web/src/routes/terminals/page.tsx` — collapse state + collapsed render;
  pin/rename/delete state; the ⋯ dropdown + context menu on each row; inline rename;
  delete `AlertDialog`; fork/select wiring.

## 7. Test isolation (binding)
Web tests need no `JINN_HOME`, but the standing rule holds: never run destructive
commands against `~/.jinn`; on unexpected data, STOP and report.
