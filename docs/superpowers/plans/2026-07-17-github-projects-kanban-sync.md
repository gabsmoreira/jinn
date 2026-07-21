# GitHub Projects ↔ Jinn Kanban Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-way sync between the Jinn web kanban and one GitHub Projects v2 board, driven by a background engine in the gateway.

**Architecture:** A new `packages/jinn/src/gateway/github-sync/` module owns all GitHub Projects v2 (GraphQL) interaction. It runs a poll loop and reacts to local board changes, reconciling the configured department's `~/.jinn/org/<dept>/board.json` against the Project's draft items. The web board is unchanged in behavior — it keeps reading/writing tickets through the existing department-board API; it only learns the 9 fixed columns and preserves two new GitHub link fields. Auth is a fine-grained PAT stored in `config.yaml` under a new `github` block.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Node's global `fetch` for GraphQL, Vitest for tests, React (web). No new runtime dependencies.

## Global Constraints

- **ESM imports:** all `packages/jinn` and `packages/web` imports use `.js` extensions (e.g. `import { foo } from "./bar.js"`).
- **Columns are a fixed ordered set of 9**, display name = GitHub Status option name (verbatim): `Backlog`, `Ready`, `Backlog | Week Goal (Onboarding Offline)`, `In progress`, `In review`, `Backlog | Testing`, `Testing`, `Ready to release`, `Done`. Slugs: `backlog`, `ready`, `backlog-week-goal`, `in-progress`, `in-review`, `backlog-testing`, `testing`, `ready-to-release`, `done`.
- **Secrets:** the PAT lives under a config key literally named `token`; `isSensitiveConfigKey()` already redacts it in `GET /api/config` — never add a differently-named token field and never log the token.
- **Atomic disk writes:** JSON stores use tmp-file + `renameSync` (mirror `cron/jobs.ts`); config writes go through `saveConfigAtomic`.
- **board.json item shape (on-disk wire contract):** `{ id: string, title: string, description?: string, status: string, priority: string, assignee?: string, createdAt: string /*ISO*/, updatedAt: string /*ISO*/, githubItemId?: string, githubSyncedAt?: number /*ms*/ }`.
- **Test command:** from the package dir, `pnpm vitest run <relative/path/to/test>` (e.g. `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/mapping.test.ts`).
- **Sync scope:** one configured department ↔ one Project (1:1). Draft items only. Last-write-wins by timestamp.

---

## File Structure

**Created (gateway):**
- `packages/jinn/src/gateway/github-sync/columns.ts` — the 9 slugs, order, slug↔GitHub-name maps.
- `packages/jinn/src/gateway/github-sync/gql-client.ts` — thin GitHub GraphQL client + project resolution.
- `packages/jinn/src/gateway/github-sync/mapping.ts` — pure board-item↔project-item + timestamp helpers.
- `packages/jinn/src/gateway/github-sync/sync-state.ts` — `~/.jinn/kanban/sync-state.json` store.
- `packages/jinn/src/gateway/github-sync/engine.ts` — reconciler + start/stop/reload/notify singleton.
- `packages/jinn/src/gateway/github-sync/board-io.ts` — read/write one department's `board.json`.
- `packages/jinn/src/gateway/github-sync/types.ts` — shared TS types for the module.
- `packages/jinn/src/gateway/github-sync/__tests__/*.test.ts` — unit tests.

**Modified (gateway):**
- `packages/jinn/src/shared/types.ts` — add `github?` block to `JinnConfig`.
- `packages/jinn/src/shared/paths.ts` — add `KANBAN_SYNC_STATE` path.
- `packages/jinn/src/gateway/api.ts` — add `github` to `KNOWN_KEYS`; add `/api/kanban/github/*` routes; call engine notify from the board PUT route.
- `packages/jinn/src/gateway/server.ts` — start/stop/reload the engine alongside the cron scheduler.

**Modified (web):**
- `packages/web/src/lib/kanban/types.ts` — new `TicketStatus`, `COLUMNS`, `githubItemId`/`githubSyncedAt`.
- `packages/web/src/lib/kanban/store.ts` — status migration + preserve new fields in `sanitizeTicket`.
- `packages/web/src/routes/kanban/page.tsx` — read/write github fields; new status mapping.
- `packages/web/src/lib/api.ts` — 5 GitHub-sync client methods.
- `packages/web/src/routes/settings/*` (or existing settings panel location) — "GitHub Projects sync" panel.

---

## Task 1: Web column model + status migration

Foundation: replace the 5 columns with the fixed 9 and migrate old ticket statuses. No GitHub yet.

**Files:**
- Modify: `packages/web/src/lib/kanban/types.ts`
- Modify: `packages/web/src/lib/kanban/store.ts`
- Test: `packages/web/src/lib/kanban/__tests__/store.test.ts` (create)

**Interfaces:**
- Produces: `TicketStatus` union of the 9 slugs; `COLUMNS: KanbanColumn[]` (9, ordered); `KanbanTicket` gains `githubItemId?: string` and `githubSyncedAt?: number`; `sanitizeTicket` migrates legacy statuses.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/kanban/__tests__/store.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { loadTickets, saveTickets } from "../store"

// jsdom provides localStorage in the web vitest env.
describe("sanitizeTicket status migration", () => {
  it("migrates legacy statuses to the new 9-column slugs", () => {
    localStorage.setItem("jinn-kanban", JSON.stringify({
      a: { title: "A", status: "todo", priority: "medium", createdAt: 1, updatedAt: 2 },
      b: { title: "B", status: "review", priority: "high", createdAt: 1, updatedAt: 2 },
      c: { title: "C", status: "in-progress", priority: "low", createdAt: 1, updatedAt: 2 },
      d: { title: "D", status: "nonsense", priority: "medium", createdAt: 1, updatedAt: 2 },
    }))
    const store = loadTickets()
    expect(store.a.status).toBe("ready")
    expect(store.b.status).toBe("in-review")
    expect(store.c.status).toBe("in-progress")
    expect(store.d.status).toBe("backlog")
  })

  it("preserves githubItemId and githubSyncedAt through a round-trip", () => {
    saveTickets({
      x: {
        id: "x", title: "X", description: "", status: "done", priority: "medium",
        assigneeId: null, department: null, workState: "idle",
        createdAt: 1, updatedAt: 2, departmentId: null,
        githubItemId: "PVTI_abc", githubSyncedAt: 999,
      },
    })
    const store = loadTickets()
    expect(store.x.githubItemId).toBe("PVTI_abc")
    expect(store.x.githubSyncedAt).toBe(999)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && pnpm vitest run src/lib/kanban/__tests__/store.test.ts`
Expected: FAIL (statuses not migrated; github fields dropped).

- [ ] **Step 3: Rewrite `types.ts`**

Replace the top of `packages/web/src/lib/kanban/types.ts`:

```ts
// Kanban board types

export type TicketStatus =
  | 'backlog'
  | 'ready'
  | 'backlog-week-goal'
  | 'in-progress'
  | 'in-review'
  | 'backlog-testing'
  | 'testing'
  | 'ready-to-release'
  | 'done'

export type TicketPriority = 'low' | 'medium' | 'high'

export type WorkState = 'idle' | 'starting' | 'working' | 'done' | 'failed'

export interface KanbanTicket {
  id: string
  title: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  assigneeId: string | null
  department: string | null
  workState: WorkState
  createdAt: number
  updatedAt: number
  departmentId: string | null
  /** GitHub Projects v2 draft-item node id, once synced. Absent = never pushed. */
  githubItemId?: string
  /** ms timestamp of the last successful reconcile for this ticket. */
  githubSyncedAt?: number
}

export interface KanbanColumn {
  id: TicketStatus
  title: string
}

export const COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready', title: 'Ready' },
  { id: 'backlog-week-goal', title: 'Backlog | Week Goal' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'in-review', title: 'In review' },
  { id: 'backlog-testing', title: 'Backlog | Testing' },
  { id: 'testing', title: 'Testing' },
  { id: 'ready-to-release', title: 'Ready to release' },
  { id: 'done', title: 'Done' },
]

/** Legacy 5-column statuses → new slug (applied once on load). */
export const LEGACY_STATUS_MIGRATION: Record<string, TicketStatus> = {
  backlog: 'backlog',
  todo: 'ready',
  'in-progress': 'in-progress',
  in_progress: 'in-progress',
  review: 'in-review',
  done: 'done',
}

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'var(--system-green)',
  medium: 'var(--system-orange)',
  high: 'var(--system-red)',
}
```

- [ ] **Step 4: Update `sanitizeTicket` in `store.ts`**

In `packages/web/src/lib/kanban/store.ts`, update the imports and `VALID_STATUSES`, and the status/return logic:

```ts
import type { KanbanTicket, TicketStatus, TicketPriority, WorkState } from './types'
import { LEGACY_STATUS_MIGRATION } from './types'

const VALID_STATUSES = new Set<TicketStatus>([
  'backlog', 'ready', 'backlog-week-goal', 'in-progress', 'in-review',
  'backlog-testing', 'testing', 'ready-to-release', 'done',
])
```

Replace the status resolution line inside `sanitizeTicket`:

```ts
  const rawStatus = raw.status as string
  const status: TicketStatus = VALID_STATUSES.has(rawStatus as TicketStatus)
    ? (rawStatus as TicketStatus)
    : (LEGACY_STATUS_MIGRATION[rawStatus] ?? 'backlog')
```

And add the two github fields to the returned object (after `departmentId`):

```ts
    githubItemId: typeof raw.githubItemId === 'string' ? raw.githubItemId : undefined,
    githubSyncedAt: typeof raw.githubSyncedAt === 'number' ? raw.githubSyncedAt : undefined,
```

Note: the existing `working`/`starting` recovery block in `loadTickets` resets to `'todo'`/`idle`; change `'todo'` to `'ready'` there so recovery lands on a valid column.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/web && pnpm vitest run src/lib/kanban/__tests__/store.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck**

Run: `cd packages/web && pnpm exec tsc --noEmit`
Expected: no errors (fix any references to removed statuses like `'todo'`/`'review'` the compiler flags).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/lib/kanban/types.ts packages/web/src/lib/kanban/store.ts packages/web/src/lib/kanban/__tests__/store.test.ts
git commit -m "feat(kanban): fixed 9-column model + legacy status migration"
```

---

## Task 2: Web board reads/writes the 9 columns + preserves GitHub link fields

The board must render the 9 columns and round-trip `githubItemId`/`githubSyncedAt` through board.json, or the engine's links get clobbered on the next save.

**Files:**
- Modify: `packages/web/src/routes/kanban/page.tsx`

**Interfaces:**
- Consumes: `COLUMNS`, `TicketStatus`, `LEGACY_STATUS_MIGRATION` from `../../lib/kanban/types`.
- Produces: board.json items now include `githubItemId`/`githubSyncedAt`.

- [ ] **Step 1: Replace the inline `statusMap` in `loadData`**

In `packages/web/src/routes/kanban/page.tsx`, inside the board-item loop, replace the local `statusMap` object and the `const status = statusMap[item.status] || 'todo'` line with a migration-aware resolver that accepts the 9 slugs directly:

```ts
import { COLUMNS, LEGACY_STATUS_MIGRATION } from '../../lib/kanban/types'
// ...
const validStatuses = new Set(COLUMNS.map((c) => c.id))
const status: TicketStatus = validStatuses.has(item.status as TicketStatus)
  ? (item.status as TicketStatus)
  : (LEGACY_STATUS_MIGRATION[item.status] ?? 'backlog')
```

And read the github fields into the ticket object (add to the `boardTickets[item.id] = {...}` literal):

```ts
  githubItemId: (item as { githubItemId?: string }).githubItemId,
  githubSyncedAt: (item as { githubSyncedAt?: number }).githubSyncedAt,
```

(Widen the `board` element type near the top of the loop to include `githubItemId?: string; githubSyncedAt?: number`.)

- [ ] **Step 2: Include github fields when writing board.json**

In BOTH `syncToApi` and `persistToApi`, add the two fields to the per-ticket object pushed into the board payload:

```ts
  githubItemId: t.githubItemId,
  githubSyncedAt: t.githubSyncedAt,
```

(In `syncToApi` the variable is `ticket`, in `persistToApi` it is `t` — match the local name. Widen the `byDept` element type in `syncToApi` to include the two optional fields.)

- [ ] **Step 3: Confirm columns render from `COLUMNS`**

Verify the board renders one column per `COLUMNS` entry (the board already maps over `COLUMNS`; no change needed if so). If any hardcoded status string (`'todo'`, `'review'`) remains in this file, replace per the new slugs.

- [ ] **Step 4: Typecheck + build**

Run: `cd packages/web && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verify**

Run the app (`/run` skill or the repo's dev command), open the kanban, confirm 9 columns render left-to-right in order and drag/drop still persists. 

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/kanban/page.tsx
git commit -m "feat(kanban): render 9 columns and preserve GitHub link fields in board.json"
```

---

## Task 3: Config type + KNOWN_KEYS

Add the `github` block to `JinnConfig` and whitelist it in the config PUT route.

**Files:**
- Modify: `packages/jinn/src/shared/types.ts`
- Modify: `packages/jinn/src/gateway/api.ts` (KNOWN_KEYS array, ~line 1776)

**Interfaces:**
- Produces: `JinnConfig["github"]` optional block with the fields below.

- [ ] **Step 1: Add the type**

In `packages/jinn/src/shared/types.ts`, add to the `JinnConfig` interface (a new optional top-level block, alongside `sessions`, `cron`, etc.):

```ts
  /** GitHub Projects v2 kanban sync. Absent = feature off. */
  github?: {
    /** Fine-grained PAT (Projects read/write). Redacted in GET /api/config. */
    token: string
    /** ProjectV2 node id (PVT_...), resolved at connect time. */
    projectId: string
    /** Human label for the settings UI, e.g. "Boldr / Roadmap". */
    projectTitle?: string
    /** Department whose board.json syncs to the Project (1:1). */
    department: string
    /** Resolved GitHub Status single-select field node id. */
    statusFieldId?: string
    /** TicketStatus slug → GitHub Status option id, resolved at connect. */
    statusOptionIds?: Record<string, string>
    /** Poll interval seconds (default 45, floor 15). */
    pollIntervalSec?: number
    /** Master on/off. false = engine never starts. */
    enabled?: boolean
  }
```

- [ ] **Step 2: Whitelist the key**

In `packages/jinn/src/gateway/api.ts`, add `"github"` to the `KNOWN_KEYS` array in the `PUT /api/config` handler.

- [ ] **Step 3: Typecheck**

Run: `cd packages/jinn && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/jinn/src/shared/types.ts packages/jinn/src/gateway/api.ts
git commit -m "feat(config): add github kanban-sync config block"
```

---

## Task 4: Column constants (gateway side)

Shared slug/name tables for the engine. Kept in `packages/jinn` (can't import web).

**Files:**
- Create: `packages/jinn/src/gateway/github-sync/columns.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/columns.test.ts`

**Interfaces:**
- Produces: `COLUMN_SLUGS: string[]` (9, ordered); `SLUG_TO_GITHUB_NAME: Record<string,string>`; `githubNameToSlug(name: string): string | undefined` (case-insensitive, trims).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { COLUMN_SLUGS, SLUG_TO_GITHUB_NAME, githubNameToSlug } from "../columns.js"

describe("columns", () => {
  it("has 9 ordered slugs", () => {
    expect(COLUMN_SLUGS).toEqual([
      "backlog", "ready", "backlog-week-goal", "in-progress", "in-review",
      "backlog-testing", "testing", "ready-to-release", "done",
    ])
  })
  it("maps slug to exact GitHub name", () => {
    expect(SLUG_TO_GITHUB_NAME["backlog-week-goal"]).toBe("Backlog | Week Goal")
    expect(SLUG_TO_GITHUB_NAME["in-progress"]).toBe("In progress")
  })
  it("resolves GitHub name to slug case-insensitively", () => {
    expect(githubNameToSlug("In Progress")).toBe("in-progress")
    expect(githubNameToSlug("  Ready to release ")).toBe("ready-to-release")
    expect(githubNameToSlug("Unknown Column")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/columns.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `columns.ts`**

```ts
/**
 * The fixed 9-column set. Display name == GitHub Status option name (verbatim).
 * Source of truth: docs/superpowers/specs/2026-07-16-github-projects-kanban-sync-design.md.
 * Kept in sync (by hand) with packages/web/src/lib/kanban/types.ts COLUMNS.
 */
export const SLUG_TO_GITHUB_NAME: Record<string, string> = {
  "backlog": "Backlog",
  "ready": "Ready",
  "backlog-week-goal": "Backlog | Week Goal",
  "in-progress": "In progress",
  "in-review": "In review",
  "backlog-testing": "Backlog | Testing",
  "testing": "Testing",
  "ready-to-release": "Ready to release",
  "done": "Done",
}

export const COLUMN_SLUGS: string[] = Object.keys(SLUG_TO_GITHUB_NAME)

const NORMALIZED_NAME_TO_SLUG = new Map<string, string>(
  Object.entries(SLUG_TO_GITHUB_NAME).map(([slug, name]) => [name.trim().toLowerCase(), slug]),
)

export function githubNameToSlug(name: string): string | undefined {
  return NORMALIZED_NAME_TO_SLUG.get(name.trim().toLowerCase())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/columns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/columns.ts packages/jinn/src/gateway/github-sync/__tests__/columns.test.ts
git commit -m "feat(github-sync): column slug/name tables"
```

---

## Task 5: Module types + board I/O

Shared types and a helper to read/write one department's board.json in the wire shape.

**Files:**
- Create: `packages/jinn/src/gateway/github-sync/types.ts`
- Create: `packages/jinn/src/gateway/github-sync/board-io.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/board-io.test.ts`

**Interfaces:**
- Produces:
  - `BoardItem` (wire shape from Global Constraints).
  - `RemoteItem { itemId: string; draftId: string | null; title: string; body: string; statusOptionId: string | null; updatedAtMs: number }`.
  - `readBoard(department: string): BoardItem[]` — `[]` if the file is missing; quarantines corrupt JSON like `cron/jobs.ts`.
  - `writeBoard(department: string, items: BoardItem[]): void` — atomic tmp+rename; creates the dept dir if missing.
  - `boardPathFor(department: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-boardio-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

describe("board-io", () => {
  it("returns [] when the board file is missing", async () => {
    const { readBoard } = await import("../board-io.js")
    expect(readBoard("engineering")).toEqual([])
  })
  it("round-trips items through write/read", async () => {
    const { readBoard, writeBoard } = await import("../board-io.js")
    const items = [{
      id: "t1", title: "Task", description: "d", status: "ready", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      githubItemId: "PVTI_1", githubSyncedAt: 42,
    }]
    writeBoard("engineering", items)
    expect(readBoard("engineering")).toEqual(items)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/board-io.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `types.ts`**

```ts
export interface BoardItem {
  id: string
  title: string
  description?: string
  status: string
  priority: string
  assignee?: string
  createdAt: string
  updatedAt: string
  githubItemId?: string
  githubSyncedAt?: number
}

export interface RemoteItem {
  itemId: string
  draftId: string | null
  title: string
  body: string
  statusOptionId: string | null
  updatedAtMs: number
}

export interface ReconcileSummary {
  created: number
  updated: number
  imported: number
  deleted: number
  error?: string
}
```

- [ ] **Step 4: Implement `board-io.ts`**

```ts
import fs from "node:fs"
import path from "node:path"
import { ORG_DIR } from "../../shared/paths.js"
import { logger } from "../../shared/logger.js"
import type { BoardItem } from "./types.js"

export function boardPathFor(department: string): string {
  return path.join(ORG_DIR, department, "board.json")
}

export function readBoard(department: string): BoardItem[] {
  const boardPath = boardPathFor(department)
  let raw: string
  try {
    raw = fs.readFileSync(boardPath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`Failed to read board ${boardPath}: ${err instanceof Error ? err.message : err}`)
    }
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BoardItem[]) : []
  } catch (err) {
    const backup = `${boardPath}.corrupt-${Date.now()}`
    try { fs.copyFileSync(boardPath, backup) } catch { /* best effort */ }
    logger.error(`Corrupt board ${boardPath}; backed up to ${backup}, treating as empty.`)
    return []
  }
}

export function writeBoard(department: string, items: BoardItem[]): void {
  const boardPath = boardPathFor(department)
  fs.mkdirSync(path.dirname(boardPath), { recursive: true })
  const tmp = `${boardPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, boardPath)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/board-io.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/types.ts packages/jinn/src/gateway/github-sync/board-io.ts packages/jinn/src/gateway/github-sync/__tests__/board-io.test.ts
git commit -m "feat(github-sync): module types + department board I/O"
```

---

## Task 6: Sync-state store

`~/.jinn/kanban/sync-state.json` for tombstones, pending deletes, and poll bookkeeping.

**Files:**
- Modify: `packages/jinn/src/shared/paths.ts`
- Create: `packages/jinn/src/gateway/github-sync/sync-state.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/sync-state.test.ts`

**Interfaces:**
- Produces:
  - `SyncState { linkedItemIds: string[]; deletedItemIds: string[]; lastPollAt: number | null; lastError: string | null }`.
    - `linkedItemIds` — every GitHub item id known to correspond to a local ticket **as of the last reconcile**. This is what lets the next reconcile tell a locally-deleted ticket (its id is in `linkedItemIds` but no longer on any local ticket) apart from a genuinely new remote item (unknown id). Without it, a Jinn-side delete boomerangs back as a re-import.
    - `deletedItemIds` — tombstones for items deleted from GitHub in response to a local delete, so a slow deletion mutation can't cause a re-import before it lands.
  - `loadSyncState(): SyncState` — defaults when missing; quarantines corrupt.
  - `saveSyncState(state: SyncState): void` — atomic.

- [ ] **Step 1: Add the path**

In `packages/jinn/src/shared/paths.ts`, add after `CRON_RUNS`:

```ts
export const KANBAN_SYNC_STATE = path.join(JINN_HOME, "kanban", "sync-state.json");
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-syncstate-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

describe("sync-state", () => {
  it("returns defaults when missing", async () => {
    const { loadSyncState } = await import("../sync-state.js")
    expect(loadSyncState()).toEqual({
      linkedItemIds: [], deletedItemIds: [], lastPollAt: null, lastError: null,
    })
  })
  it("round-trips", async () => {
    const { loadSyncState, saveSyncState } = await import("../sync-state.js")
    saveSyncState({ linkedItemIds: ["a"], deletedItemIds: ["b"], lastPollAt: 5, lastError: "x" })
    expect(loadSyncState()).toEqual({
      linkedItemIds: ["a"], deletedItemIds: ["b"], lastPollAt: 5, lastError: "x",
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/sync-state.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `sync-state.ts`**

```ts
import fs from "node:fs"
import path from "node:path"
import { KANBAN_SYNC_STATE } from "../../shared/paths.js"
import { logger } from "../../shared/logger.js"

export interface SyncState {
  /** GitHub item ids linked to a local ticket as of the last reconcile. */
  linkedItemIds: string[]
  /** Tombstones for items deleted from GitHub due to a local delete. */
  deletedItemIds: string[]
  lastPollAt: number | null
  lastError: string | null
}

function defaults(): SyncState {
  return { linkedItemIds: [], deletedItemIds: [], lastPollAt: null, lastError: null }
}

export function loadSyncState(): SyncState {
  let raw: string
  try {
    raw = fs.readFileSync(KANBAN_SYNC_STATE, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`Failed to read sync-state: ${err instanceof Error ? err.message : err}`)
    }
    return defaults()
  }
  try {
    return { ...defaults(), ...(JSON.parse(raw) as Partial<SyncState>) }
  } catch (err) {
    const backup = `${KANBAN_SYNC_STATE}.corrupt-${Date.now()}`
    try { fs.copyFileSync(KANBAN_SYNC_STATE, backup) } catch { /* best effort */ }
    logger.error(`Corrupt sync-state; backed up to ${backup}, starting fresh.`)
    return defaults()
  }
}

export function saveSyncState(state: SyncState): void {
  fs.mkdirSync(path.dirname(KANBAN_SYNC_STATE), { recursive: true })
  const tmp = `${KANBAN_SYNC_STATE}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, KANBAN_SYNC_STATE)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/sync-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/shared/paths.ts packages/jinn/src/gateway/github-sync/sync-state.ts packages/jinn/src/gateway/github-sync/__tests__/sync-state.test.ts
git commit -m "feat(github-sync): sync-state store"
```

---

## Task 7: Mapping (pure reconcile helpers)

Pure functions the engine uses: build a draft's title/body from a board item, map status both directions, and decide the last-write-wins outcome.

**Files:**
- Create: `packages/jinn/src/gateway/github-sync/mapping.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/mapping.test.ts`

**Interfaces:**
- Consumes: `BoardItem`, `RemoteItem` from `./types.js`; `githubNameToSlug`, `SLUG_TO_GITHUB_NAME` from `./columns.js`.
- Produces:
  - `statusOptionIdForItem(item: BoardItem, statusOptionIds: Record<string,string>): string | null` — the GitHub option id for the item's slug (or null if unmapped).
  - `slugForOptionId(optionId: string | null, statusOptionIds: Record<string,string>): string` — inverse; falls back to `"backlog"`.
  - `msOf(iso: string): number` — ISO→ms (0 if invalid).
  - `resolveConflict(item, remote, syncedAt): "push" | "pull" | "noop"` — last-write-wins.
  - `applyRemoteToItem(item, remote, statusOptionIds, nowIso): BoardItem` — returns a new item with remote title/body/status + refreshed `updatedAt`.
  - `remoteToNewItem(remote, statusOptionIds, id, nowIso): BoardItem` — build a brand-new board item from a remote-only project item.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import {
  statusOptionIdForItem, slugForOptionId, msOf, resolveConflict,
  applyRemoteToItem, remoteToNewItem,
} from "../mapping.js"
import type { BoardItem, RemoteItem } from "../types.js"

const OPTS = { "in-progress": "opt_ip", "done": "opt_done", "backlog": "opt_bk" }

const baseItem: BoardItem = {
  id: "t1", title: "T", description: "body", status: "in-progress", priority: "medium",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  githubItemId: "PVTI_1", githubSyncedAt: msOf("2026-01-02T00:00:00.000Z"),
}
const baseRemote: RemoteItem = {
  itemId: "PVTI_1", draftId: "DI_1", title: "T", body: "body",
  statusOptionId: "opt_ip", updatedAtMs: msOf("2026-01-02T00:00:00.000Z"),
}

describe("mapping", () => {
  it("maps slug to option id and back", () => {
    expect(statusOptionIdForItem(baseItem, OPTS)).toBe("opt_ip")
    expect(slugForOptionId("opt_done", OPTS)).toBe("done")
    expect(slugForOptionId("unknown", OPTS)).toBe("backlog")
    expect(slugForOptionId(null, OPTS)).toBe("backlog")
  })
  it("resolveConflict: only-local change pushes", () => {
    const item = { ...baseItem, updatedAt: "2026-01-03T00:00:00.000Z" }
    expect(resolveConflict(item, baseRemote, item.githubSyncedAt!)).toBe("push")
  })
  it("resolveConflict: only-remote change pulls", () => {
    const remote = { ...baseRemote, updatedAtMs: msOf("2026-01-05T00:00:00.000Z") }
    expect(resolveConflict(baseItem, remote, baseItem.githubSyncedAt!)).toBe("pull")
  })
  it("resolveConflict: both changed → newer wins", () => {
    const item = { ...baseItem, updatedAt: "2026-01-04T00:00:00.000Z" }
    const remote = { ...baseRemote, updatedAtMs: msOf("2026-01-06T00:00:00.000Z") }
    expect(resolveConflict(item, remote, baseItem.githubSyncedAt!)).toBe("pull")
    const remote2 = { ...baseRemote, updatedAtMs: msOf("2026-01-03T00:00:00.000Z") }
    expect(resolveConflict(item, remote2, baseItem.githubSyncedAt!)).toBe("push")
  })
  it("resolveConflict: neither changed → noop", () => {
    expect(resolveConflict(baseItem, baseRemote, baseItem.githubSyncedAt!)).toBe("noop")
  })
  it("applyRemoteToItem copies title/body/status", () => {
    const remote = { ...baseRemote, title: "New", body: "nb", statusOptionId: "opt_done" }
    const out = applyRemoteToItem(baseItem, remote, OPTS, "2026-02-01T00:00:00.000Z")
    expect(out.title).toBe("New")
    expect(out.description).toBe("nb")
    expect(out.status).toBe("done")
    expect(out.updatedAt).toBe("2026-02-01T00:00:00.000Z")
    expect(out.id).toBe("t1")
  })
  it("remoteToNewItem builds a fresh backlog-fallback item", () => {
    const remote = { ...baseRemote, statusOptionId: "opt_weird" }
    const out = remoteToNewItem(remote, OPTS, "newid", "2026-02-01T00:00:00.000Z")
    expect(out.id).toBe("newid")
    expect(out.status).toBe("backlog")
    expect(out.githubItemId).toBe("PVTI_1")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/mapping.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `mapping.ts`**

```ts
import type { BoardItem, RemoteItem } from "./types.js"

export function msOf(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

export function statusOptionIdForItem(
  item: BoardItem,
  statusOptionIds: Record<string, string>,
): string | null {
  return statusOptionIds[item.status] ?? null
}

export function slugForOptionId(
  optionId: string | null,
  statusOptionIds: Record<string, string>,
): string {
  if (!optionId) return "backlog"
  for (const [slug, id] of Object.entries(statusOptionIds)) {
    if (id === optionId) return slug
  }
  return "backlog"
}

export function resolveConflict(
  item: BoardItem,
  remote: RemoteItem,
  syncedAt: number,
): "push" | "pull" | "noop" {
  const localChanged = msOf(item.updatedAt) > syncedAt
  const remoteChanged = remote.updatedAtMs > syncedAt
  if (localChanged && remoteChanged) {
    return msOf(item.updatedAt) >= remote.updatedAtMs ? "push" : "pull"
  }
  if (localChanged) return "push"
  if (remoteChanged) return "pull"
  return "noop"
}

export function applyRemoteToItem(
  item: BoardItem,
  remote: RemoteItem,
  statusOptionIds: Record<string, string>,
  nowIso: string,
): BoardItem {
  return {
    ...item,
    title: remote.title,
    description: remote.body,
    status: slugForOptionId(remote.statusOptionId, statusOptionIds),
    updatedAt: nowIso,
    githubSyncedAt: msOf(nowIso),
  }
}

export function remoteToNewItem(
  remote: RemoteItem,
  statusOptionIds: Record<string, string>,
  id: string,
  nowIso: string,
): BoardItem {
  return {
    id,
    title: remote.title,
    description: remote.body,
    status: slugForOptionId(remote.statusOptionId, statusOptionIds),
    priority: "medium",
    createdAt: nowIso,
    updatedAt: nowIso,
    githubItemId: remote.itemId,
    githubSyncedAt: msOf(nowIso),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/mapping.ts packages/jinn/src/gateway/github-sync/__tests__/mapping.test.ts
git commit -m "feat(github-sync): pure mapping + last-write-wins helpers"
```

---

## Task 8: GraphQL client

Thin GitHub Projects v2 client. All network I/O is funneled through an injectable `fetchImpl` so it is testable without real HTTP.

**Files:**
- Create: `packages/jinn/src/gateway/github-sync/gql-client.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/gql-client.test.ts`

**Interfaces:**
- Produces:
  - `type FetchImpl = typeof fetch`.
  - `createGithubClient(token: string, fetchImpl?: FetchImpl)` returning an object with:
    - `resolveProject(urlOrId: string): Promise<{ projectId: string; title: string; statusFieldId: string; options: { id: string; name: string }[] }>`.
    - `listItems(projectId: string): Promise<RemoteItem[]>` (paginates).
    - `createDraft(projectId: string, title: string, body: string): Promise<string /*itemId*/>`.
    - `updateDraft(draftId: string, title: string, body: string): Promise<void>`.
    - `setStatus(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>`.
    - `deleteItem(projectId: string, itemId: string): Promise<void>`.
  - `parseProjectRef(urlOrId: string): { nodeId: string } | { ownerType: "org" | "user"; login: string; number: number }` — exported for testing.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest"
import { parseProjectRef, createGithubClient } from "../gql-client.js"

describe("parseProjectRef", () => {
  it("passes through a PVT_ node id", () => {
    expect(parseProjectRef("PVT_abc123")).toEqual({ nodeId: "PVT_abc123" })
  })
  it("parses an org project URL", () => {
    expect(parseProjectRef("https://github.com/orgs/boldr/projects/7")).toEqual({
      ownerType: "org", login: "boldr", number: 7,
    })
  })
  it("parses a user project URL", () => {
    expect(parseProjectRef("https://github.com/users/nico/projects/3")).toEqual({
      ownerType: "user", login: "nico", number: 3,
    })
  })
})

describe("createGithubClient.listItems", () => {
  it("maps draft nodes to RemoteItem and paginates", async () => {
    const pages = [
      {
        data: { node: { items: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [{
            id: "PVTI_1", updatedAt: "2026-01-02T00:00:00Z",
            content: { id: "DI_1", title: "A", body: "ba" },
            fieldValueByName: { optionId: "opt_ip", name: "In progress" },
          }],
        } } },
      },
      {
        data: { node: { items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: "PVTI_2", updatedAt: "2026-01-03T00:00:00Z",
            content: { id: "DI_2", title: "B", body: "" },
            fieldValueByName: null,
          }],
        } } },
      },
    ]
    let call = 0
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => pages[call++],
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    const items = await client.listItems("PVT_x")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      itemId: "PVTI_1", draftId: "DI_1", title: "A", body: "ba", statusOptionId: "opt_ip",
    })
    expect(items[1]).toMatchObject({ itemId: "PVTI_2", statusOptionId: null })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("throws a clear error on a GraphQL error response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ errors: [{ message: "Bad credentials" }] }),
    })) as unknown as typeof fetch
    const client = createGithubClient("tok", fetchImpl)
    await expect(client.listItems("PVT_x")).rejects.toThrow(/Bad credentials/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/gql-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `gql-client.ts`**

```ts
import type { RemoteItem } from "./types.js"

export type FetchImpl = typeof fetch

const GRAPHQL_URL = "https://api.github.com/graphql"

export type ProjectRef =
  | { nodeId: string }
  | { ownerType: "org" | "user"; login: string; number: number }

export function parseProjectRef(urlOrId: string): ProjectRef {
  const s = urlOrId.trim()
  if (s.startsWith("PVT_")) return { nodeId: s }
  const org = s.match(/github\.com\/orgs\/([^/]+)\/projects\/(\d+)/)
  if (org) return { ownerType: "org", login: org[1], number: Number(org[2]) }
  const user = s.match(/github\.com\/users\/([^/]+)\/projects\/(\d+)/)
  if (user) return { ownerType: "user", login: user[1], number: Number(user[2]) }
  throw new Error(`Unrecognized project reference: ${urlOrId}`)
}

export function createGithubClient(token: string, fetchImpl: FetchImpl = fetch) {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "jinn-kanban-sync",
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
    const payload = (await res.json()) as { data?: T; errors?: { message: string }[] }
    if (payload.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`)
    }
    if (!payload.data) throw new Error("GitHub GraphQL: empty response")
    return payload.data
  }

  async function resolveProject(urlOrId: string) {
    const ref = parseProjectRef(urlOrId)
    let projectId: string
    if ("nodeId" in ref) {
      projectId = ref.nodeId
    } else {
      const q = ref.ownerType === "org"
        ? `query($login:String!,$number:Int!){organization(login:$login){projectV2(number:$number){id}}}`
        : `query($login:String!,$number:Int!){user(login:$login){projectV2(number:$number){id}}}`
      const d = await gql<{ organization?: { projectV2: { id: string } }; user?: { projectV2: { id: string } } }>(
        q, { login: ref.login, number: ref.number },
      )
      const id = d.organization?.projectV2.id ?? d.user?.projectV2.id
      if (!id) throw new Error("Project not found or PAT lacks access")
      projectId = id
    }
    const detail = await gql<{ node: {
      title: string
      field: { id: string; options: { id: string; name: string }[] } | null
    } }>(
      `query($id:ID!){node(id:$id){... on ProjectV2{title field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { id: projectId },
    )
    if (!detail.node.field) throw new Error('Project has no "Status" single-select field')
    return {
      projectId,
      title: detail.node.title,
      statusFieldId: detail.node.field.id,
      options: detail.node.field.options,
    }
  }

  async function listItems(projectId: string): Promise<RemoteItem[]> {
    const out: RemoteItem[] = []
    let cursor: string | null = null
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const d: { node: { items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<{
          id: string
          updatedAt: string
          content: { id: string; title: string; body: string | null } | null
          fieldValueByName: { optionId: string; name: string } | null
        }>
      } } } = await gql(
        `query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{items(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id updatedAt content{... on DraftIssue{id title body}}fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{optionId name}}}}}}}`,
        { id: projectId, cursor },
      )
      const items = d.node.items
      for (const n of items.nodes) {
        // Only sync draft issues (skip pulled-in issues/PRs which have no DraftIssue content).
        if (!n.content) continue
        out.push({
          itemId: n.id,
          draftId: n.content.id,
          title: n.content.title,
          body: n.content.body ?? "",
          statusOptionId: n.fieldValueByName?.optionId ?? null,
          updatedAtMs: Date.parse(n.updatedAt) || 0,
        })
      }
      if (!items.pageInfo.hasNextPage) break
      cursor = items.pageInfo.endCursor
    }
    return out
  }

  async function createDraft(projectId: string, title: string, body: string): Promise<string> {
    const d = await gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(
      `mutation($projectId:ID!,$title:String!,$body:String){addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}){projectItem{id}}}`,
      { projectId, title, body },
    )
    return d.addProjectV2DraftIssue.projectItem.id
  }

  async function updateDraft(draftId: string, title: string, body: string): Promise<void> {
    await gql(
      `mutation($id:ID!,$title:String!,$body:String){updateProjectV2DraftIssue(input:{draftIssueId:$id,title:$title,body:$body}){draftIssue{id}}}`,
      { id: draftId, title, body },
    )
  }

  async function setStatus(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await gql(
      `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}`,
      { projectId, itemId, fieldId, optionId },
    )
  }

  async function deleteItem(projectId: string, itemId: string): Promise<void> {
    await gql(
      `mutation($projectId:ID!,$itemId:ID!){deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){deletedItemId}}`,
      { projectId, itemId },
    )
  }

  return { resolveProject, listItems, createDraft, updateDraft, setStatus, deleteItem }
}

export type GithubClient = ReturnType<typeof createGithubClient>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/gql-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/gql-client.ts packages/jinn/src/gateway/github-sync/__tests__/gql-client.test.ts
git commit -m "feat(github-sync): GitHub Projects v2 GraphQL client"
```

---

## Task 9: Reconcile engine

The reconciler ties client + mapping + board-io + sync-state together. Tested against a fake client and a temp board.json. `reconcile()` is exported separately from the singleton loop so it can be unit-tested directly.

**Files:**
- Create: `packages/jinn/src/gateway/github-sync/engine.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `GithubClient` (Task 8), `readBoard`/`writeBoard` (Task 5), `loadSyncState`/`saveSyncState` (Task 6), mapping helpers (Task 7), `JinnConfig["github"]` (Task 3).
- Produces:
  - `reconcile(deps: ReconcileDeps): Promise<ReconcileSummary>` where
    `ReconcileDeps { client: GithubClient; github: NonNullable<JinnConfig["github"]>; nowIso: string; newId: () => string; emit?: (event: string, payload: unknown) => void }`.
  - Singleton controls: `startGithubSync(getConfig, emit)`, `stopGithubSync()`, `reloadGithubSync(getConfig, emit)`, `notifyBoardChange(department)`, `syncNow(): Promise<ReconcileSummary>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

const github = {
  token: "tok", projectId: "PVT_x", department: "engineering",
  statusFieldId: "F_status",
  statusOptionIds: { "in-progress": "opt_ip", "done": "opt_done", "backlog": "opt_bk" },
  enabled: true,
}

function fakeClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    resolveProject: vi.fn(),
    listItems: vi.fn(async () => [] as any[]),
    createDraft: vi.fn(async () => "PVTI_new"),
    updateDraft: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("reconcile", () => {
  it("creates a draft for a local-only ticket and stores its item id", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "New task", description: "d", status: "in-progress", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }])
    const client = fakeClient()
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "gen" })
    expect(client.createDraft).toHaveBeenCalledWith("PVT_x", "New task", "d")
    expect(client.setStatus).toHaveBeenCalledWith("PVT_x", "PVTI_new", "F_status", "opt_ip")
    expect(summary.created).toBe(1)
    const board = readBoard("engineering")
    expect(board[0].githubItemId).toBe("PVTI_new")
    expect(board[0].githubSyncedAt).toBe(Date.parse("2026-02-01T00:00:00.000Z"))
  })

  it("imports a remote-only draft as a new local ticket", async () => {
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "rb",
        statusOptionId: "opt_done", updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "imported1" })
    expect(summary.imported).toBe(1)
    const board = readBoard("engineering")
    expect(board[0]).toMatchObject({ id: "imported1", title: "Remote", status: "done", githubItemId: "PVTI_r" })
  })

  it("does not re-import a tombstoned remote item", async () => {
    const { saveSyncState } = await import("../sync-state.js")
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    saveSyncState({ linkedItemIds: [], deletedItemIds: ["PVTI_r"], lastPollAt: null, lastError: null })
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "",
        statusOptionId: null, updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.imported).toBe(0)
    expect(readBoard("engineering")).toEqual([])
  })

  it("deletes on GitHub (not re-imports) when a previously-linked ticket was removed locally", async () => {
    // A ticket was linked to PVTI_r before, but the local board no longer has it
    // (user deleted it in Jinn). The remote item still exists → delete on GitHub.
    const { saveSyncState, loadSyncState } = await import("../sync-state.js")
    const { readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    saveSyncState({ linkedItemIds: ["PVTI_r"], deletedItemIds: [], lastPollAt: null, lastError: null })
    const client = fakeClient({
      listItems: vi.fn(async () => [{
        itemId: "PVTI_r", draftId: "DI_r", title: "Remote", body: "",
        statusOptionId: null, updatedAtMs: Date.parse("2026-01-05T00:00:00Z"),
      }]),
    })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(client.deleteItem).toHaveBeenCalledWith("PVT_x", "PVTI_r")
    expect(summary.imported).toBe(0)
    expect(summary.deleted).toBe(1)
    expect(readBoard("engineering")).toEqual([])
    expect(loadSyncState().deletedItemIds).toContain("PVTI_r")
  })

  it("deletes a linked local ticket that vanished from GitHub", async () => {
    const { writeBoard, readBoard } = await import("../board-io.js")
    const { reconcile } = await import("../engine.js")
    writeBoard("engineering", [{
      id: "t1", title: "Linked", description: "", status: "done", priority: "medium",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      githubItemId: "PVTI_gone", githubSyncedAt: Date.parse("2026-01-01T00:00:00Z"),
    }])
    const client = fakeClient({ listItems: vi.fn(async () => []) })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.deleted).toBe(1)
    expect(readBoard("engineering")).toEqual([])
  })

  it("records lastError and rethrows nothing when the client fails", async () => {
    const { loadSyncState } = await import("../sync-state.js")
    const { reconcile } = await import("../engine.js")
    const client = fakeClient({ listItems: vi.fn(async () => { throw new Error("boom") }) })
    const summary = await reconcile({ client: client as any, github, nowIso: "2026-02-01T00:00:00.000Z", newId: () => "x" })
    expect(summary.error).toMatch(/boom/)
    expect(loadSyncState().lastError).toMatch(/boom/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `engine.ts`**

```ts
import { randomUUID } from "node:crypto"
import type { JinnConfig } from "../../shared/types.js"
import { logger } from "../../shared/logger.js"
import { readBoard, writeBoard } from "./board-io.js"
import { loadSyncState, saveSyncState } from "./sync-state.js"
import type { GithubClient } from "./gql-client.js"
import { createGithubClient } from "./gql-client.js"
import type { BoardItem, ReconcileSummary } from "./types.js"
import {
  statusOptionIdForItem, resolveConflict, applyRemoteToItem, remoteToNewItem, msOf,
} from "./mapping.js"

type Github = NonNullable<JinnConfig["github"]>

export interface ReconcileDeps {
  client: GithubClient
  github: Github
  nowIso: string
  newId: () => string
  emit?: (event: string, payload: unknown) => void
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { client, github, nowIso, newId, emit } = deps
  const summary: ReconcileSummary = { created: 0, updated: 0, imported: 0, deleted: 0 }
  const state = loadSyncState()
  const optionIds = github.statusOptionIds ?? {}
  const fieldId = github.statusFieldId ?? ""

  try {
    const remote = await client.listItems(github.projectId)
    const remoteById = new Map(remote.map((r) => [r.itemId, r]))
    const local = readBoard(github.department)
    const nextLocal: BoardItem[] = []

    // Local-side pass: linked / local-only / delete-remote.
    for (const item of local) {
      if (item.githubItemId) {
        const match = remoteById.get(item.githubItemId)
        if (!match) {
          // Linked item vanished from GitHub → delete locally.
          summary.deleted++
          continue
        }
        remoteById.delete(item.githubItemId) // consumed; leftover = remote-only
        const decision = resolveConflict(item, match, item.githubSyncedAt ?? 0)
        if (decision === "push") {
          if (match.draftId) await client.updateDraft(match.draftId, item.title, item.description ?? "")
          const optId = statusOptionIdForItem(item, optionIds)
          if (optId && fieldId) await client.setStatus(github.projectId, item.githubItemId, fieldId, optId)
          summary.updated++
          nextLocal.push({ ...item, githubSyncedAt: msOf(nowIso) })
        } else if (decision === "pull") {
          summary.updated++
          nextLocal.push(applyRemoteToItem(item, match, optionIds, nowIso))
        } else {
          nextLocal.push(item)
        }
      } else {
        // Local-only → create draft on GitHub.
        const itemId = await client.createDraft(github.projectId, item.title, item.description ?? "")
        const optId = statusOptionIdForItem(item, optionIds)
        if (optId && fieldId) await client.setStatus(github.projectId, itemId, fieldId, optId)
        summary.created++
        nextLocal.push({ ...item, githubItemId: itemId, githubSyncedAt: msOf(nowIso) })
      }
    }

    // Remote-only pass. A leftover remote item is one of:
    //   • tombstoned            → skip
    //   • previously linked here → the local ticket was deleted in Jinn → delete on GitHub
    //   • genuinely new          → import as a new local ticket
    const tombstones = new Set(state.deletedItemIds)
    const previouslyLinked = new Set(state.linkedItemIds)
    const newTombstones = [...state.deletedItemIds]
    for (const r of remoteById.values()) {
      if (tombstones.has(r.itemId)) continue
      if (previouslyLinked.has(r.itemId)) {
        await client.deleteItem(github.projectId, r.itemId)
        newTombstones.push(r.itemId)
        summary.deleted++
        continue
      }
      nextLocal.push(remoteToNewItem(r, optionIds, newId(), nowIso))
      summary.imported++
    }

    writeBoard(github.department, nextLocal)
    const linkedItemIds = nextLocal
      .map((i) => i.githubItemId)
      .filter((id): id is string => Boolean(id))
    saveSyncState({
      linkedItemIds,
      deletedItemIds: newTombstones,
      lastPollAt: msOf(nowIso),
      lastError: null,
    })
    if (summary.deleted || summary.imported || summary.updated || summary.created) {
      emit?.("board:updated", { department: github.department })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.error = message
    saveSyncState({ ...state, lastError: message })
    logger.error(`GitHub sync reconcile failed: ${message}`)
  }
  return summary
}

// ---- Singleton loop control ----

let timer: NodeJS.Timeout | null = null
let running = false
let rerun = false
let debounce: NodeJS.Timeout | null = null
let currentGetConfig: (() => JinnConfig) | null = null
let currentEmit: ((event: string, payload: unknown) => void) | undefined

function activeGithub(getConfig: () => JinnConfig): Github | null {
  const g = getConfig().github
  if (!g || !g.enabled || !g.token || !g.projectId) return null
  return g
}

async function runOnce(): Promise<ReconcileSummary> {
  if (!currentGetConfig) return { created: 0, updated: 0, imported: 0, deleted: 0 }
  const github = activeGithub(currentGetConfig)
  if (!github) return { created: 0, updated: 0, imported: 0, deleted: 0 }
  if (running) { rerun = true; return { created: 0, updated: 0, imported: 0, deleted: 0 } }
  running = true
  try {
    const client = createGithubClient(github.token)
    return await reconcile({
      client, github, nowIso: new Date().toISOString(), newId: () => randomUUID(), emit: currentEmit,
    })
  } finally {
    running = false
    if (rerun) { rerun = false; void runOnce() }
  }
}

export function startGithubSync(getConfig: () => JinnConfig, emit: (event: string, payload: unknown) => void): void {
  currentGetConfig = getConfig
  currentEmit = emit
  const github = activeGithub(getConfig)
  if (!github) { logger.info("GitHub kanban sync: disabled (no config)"); return }
  const intervalMs = Math.max(15, github.pollIntervalSec ?? 45) * 1000
  logger.info(`GitHub kanban sync: polling every ${intervalMs / 1000}s for department "${github.department}"`)
  void runOnce()
  timer = setInterval(() => void runOnce(), intervalMs)
}

export function stopGithubSync(): void {
  if (timer) clearInterval(timer)
  if (debounce) clearTimeout(debounce)
  timer = null; debounce = null; running = false; rerun = false
}

export function reloadGithubSync(getConfig: () => JinnConfig, emit: (event: string, payload: unknown) => void): void {
  stopGithubSync()
  startGithubSync(getConfig, emit)
}

export function notifyBoardChange(department: string): void {
  if (!currentGetConfig) return
  const github = activeGithub(currentGetConfig)
  if (!github || github.department !== department) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { debounce = null; void runOnce() }, 2000)
}

export async function syncNow(): Promise<ReconcileSummary> {
  return runOnce()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/engine.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Typecheck**

Run: `cd packages/jinn && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/engine.ts packages/jinn/src/gateway/github-sync/__tests__/engine.test.ts
git commit -m "feat(github-sync): reconcile engine + poll/debounce singleton"
```

---

## Task 10: HTTP routes

Expose connect/status/config/sync-now/disconnect over the gateway API.

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts`
- Test: `packages/jinn/src/gateway/github-sync/__tests__/routes.test.ts` (tests the pure helper below)

To keep `api.ts` thin and testable, put the connect logic in a helper `resolveConnectConfig` in a new file `packages/jinn/src/gateway/github-sync/connect.ts` and unit-test that; the route just wires it.

**Interfaces:**
- Produces (`connect.ts`):
  - `buildStatusOptionIds(options: {id:string;name:string}[]): { statusOptionIds: Record<string,string>; unmatchedColumns: string[]; unmatchedGithub: string[] }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { buildStatusOptionIds } from "../connect.js"

describe("buildStatusOptionIds", () => {
  it("matches GitHub options to column slugs by name", () => {
    const { statusOptionIds, unmatchedColumns, unmatchedGithub } = buildStatusOptionIds([
      { id: "o1", name: "Backlog" },
      { id: "o2", name: "In progress" },
      { id: "o3", name: "Done" },
      { id: "o4", name: "Icebox" },
    ])
    expect(statusOptionIds["backlog"]).toBe("o1")
    expect(statusOptionIds["in-progress"]).toBe("o2")
    expect(statusOptionIds["done"]).toBe("o3")
    expect(unmatchedGithub).toContain("Icebox")
    expect(unmatchedColumns).toContain("ready")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `connect.ts`**

```ts
import { COLUMN_SLUGS, githubNameToSlug, SLUG_TO_GITHUB_NAME } from "./columns.js"

export function buildStatusOptionIds(options: { id: string; name: string }[]): {
  statusOptionIds: Record<string, string>
  unmatchedColumns: string[]
  unmatchedGithub: string[]
} {
  const statusOptionIds: Record<string, string> = {}
  const unmatchedGithub: string[] = []
  for (const opt of options) {
    const slug = githubNameToSlug(opt.name)
    if (slug) statusOptionIds[slug] = opt.id
    else unmatchedGithub.push(opt.name)
  }
  const unmatchedColumns = COLUMN_SLUGS.filter((slug) => !(slug in statusOptionIds))
    .map((slug) => SLUG_TO_GITHUB_NAME[slug])
  return { statusOptionIds, unmatchedColumns, unmatchedGithub }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm vitest run src/gateway/github-sync/__tests__/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the routes in `api.ts`**

Add imports at the top of `packages/jinn/src/gateway/api.ts`:

```ts
import { createGithubClient } from "./github-sync/gql-client.js";
import { buildStatusOptionIds } from "./github-sync/connect.js";
import { loadSyncState } from "./github-sync/sync-state.js";
import { syncNow as githubSyncNow } from "./github-sync/engine.js";
```

Insert these blocks in the `handleApiRequest` if-chain (near the other `/api/*` routes, e.g. just after the config routes):

```ts
    // GET /api/kanban/github/status
    if (method === "GET" && pathname === "/api/kanban/github/status") {
      const g = context.getConfig().github;
      const state = loadSyncState();
      return json(res, {
        connected: Boolean(g?.token && g?.projectId),
        enabled: Boolean(g?.enabled),
        projectTitle: g?.projectTitle ?? null,
        department: g?.department ?? null,
        pollIntervalSec: g?.pollIntervalSec ?? 45,
        lastPollAt: state.lastPollAt,
        lastError: state.lastError,
      });
    }

    // POST /api/kanban/github/connect  { token, projectUrlOrId, department }
    if (method === "POST" && pathname === "/api/kanban/github/connect") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as { token?: string; projectUrlOrId?: string; department?: string };
      if (!body.token || !body.projectUrlOrId || !body.department) {
        return badRequest(res, "token, projectUrlOrId and department are required");
      }
      let resolved;
      try {
        resolved = await createGithubClient(body.token).resolveProject(body.projectUrlOrId);
      } catch (err) {
        return badRequest(res, `Could not connect to GitHub: ${err instanceof Error ? err.message : err}`);
      }
      const { statusOptionIds, unmatchedColumns, unmatchedGithub } = buildStatusOptionIds(resolved.options);
      const existing = (() => { try { return yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {}; } catch { return {}; } })();
      const merged = { ...existing, github: {
        token: body.token, projectId: resolved.projectId, projectTitle: resolved.title,
        department: body.department, statusFieldId: resolved.statusFieldId, statusOptionIds,
        pollIntervalSec: 45, enabled: true,
      } };
      saveConfigAtomic(merged);
      context.reloadConfig?.();
      context.emit("github-sync:reloaded", {});
      return json(res, { status: "ok", projectTitle: resolved.title, unmatchedColumns, unmatchedGithub });
    }

    // PUT /api/kanban/github/config  { pollIntervalSec?, enabled?, department? }
    if (method === "PUT" && pathname === "/api/kanban/github/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as Record<string, unknown>;
      const g = context.getConfig().github;
      if (!g) return badRequest(res, "GitHub sync is not connected");
      const patch: Record<string, unknown> = {};
      if (typeof body.pollIntervalSec === "number") patch.pollIntervalSec = Math.max(15, body.pollIntervalSec);
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.department === "string") patch.department = body.department;
      const existing = (() => { try { return yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {}; } catch { return {}; } })();
      const merged = { ...existing, github: { ...(existing.github as object), ...patch } };
      saveConfigAtomic(merged);
      context.reloadConfig?.();
      context.emit("github-sync:reloaded", {});
      return json(res, { status: "ok" });
    }

    // POST /api/kanban/github/sync-now
    if (method === "POST" && pathname === "/api/kanban/github/sync-now") {
      if (!context.getConfig().github?.enabled) return badRequest(res, "GitHub sync is disabled");
      const summary = await githubSyncNow();
      return json(res, summary);
    }

    // POST /api/kanban/github/disconnect
    if (method === "POST" && pathname === "/api/kanban/github/disconnect") {
      const existing = (() => { try { return yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {}; } catch { return {}; } })();
      delete (existing as Record<string, unknown>).github;
      saveConfigAtomic(existing);
      context.reloadConfig?.();
      context.emit("github-sync:reloaded", {});
      return json(res, { status: "ok" });
    }
```

(Note: `yaml`, `fs`, `CONFIG_PATH`, `saveConfigAtomic` are already imported in `api.ts` for the config route — reuse them.)

- [ ] **Step 6: Typecheck**

Run: `cd packages/jinn && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/jinn/src/gateway/github-sync/connect.ts packages/jinn/src/gateway/github-sync/__tests__/routes.test.ts packages/jinn/src/gateway/api.ts
git commit -m "feat(github-sync): connect/status/config/sync-now/disconnect routes"
```

---

## Task 11: Server wiring (start/stop/reload + board-change notify)

Start the engine at boot, restart it on config reload, stop it on shutdown, and notify it when the board changes.

**Files:**
- Modify: `packages/jinn/src/gateway/server.ts`
- Modify: `packages/jinn/src/gateway/api.ts` (board PUT route)

- [ ] **Step 1: Import the engine controls in `server.ts`**

Add near the scheduler import (`server.ts:57`):

```ts
import { startGithubSync, stopGithubSync, reloadGithubSync } from "./github-sync/engine.js";
```

- [ ] **Step 2: Start the engine after the cron scheduler**

After `startScheduler(...)` (~`server.ts:782`), add (this must be after `emit` is defined; if `emit` is defined later in the file, place this call right after the `emit` definition and `getConfig` is available — use `() => currentConfig`):

```ts
  // Start GitHub Projects kanban sync (no-op unless config.github.enabled)
  startGithubSync(() => currentConfig, emit);
```

Note: `currentConfig` and `emit` are defined a few lines below the scheduler start in the current file. Place the `startGithubSync` call immediately after the `emit` definition block (after `server.ts:804`) so both are in scope.

- [ ] **Step 3: Reload on config reload**

Inside the `reloadConfig` function (after `emit("config:reloaded", {})`, ~`server.ts:895`), add:

```ts
      reloadGithubSync(() => currentConfig, emit);
```

- [ ] **Step 4: Stop on shutdown**

Next to `stopScheduler();` in the shutdown path (~`server.ts:1218`), add:

```ts
    stopGithubSync();
```

- [ ] **Step 5: Notify on board change in `api.ts`**

In the `PUT /api/org/departments/:name/board` handler (~`api.ts:1675`), after `context.emit("board:updated", { department: p.name });`, add:

```ts
      notifyBoardChange(p.name);
```

And import at the top of `api.ts` (extend the engine import from Task 10):

```ts
import { syncNow as githubSyncNow, notifyBoardChange } from "./github-sync/engine.js";
```

- [ ] **Step 6: Typecheck + full test suite**

Run: `cd packages/jinn && pnpm exec tsc --noEmit && pnpm vitest run src/gateway/github-sync`
Expected: no type errors; all github-sync tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/jinn/src/gateway/server.ts packages/jinn/src/gateway/api.ts
git commit -m "feat(github-sync): wire engine into gateway lifecycle + board-change notify"
```

---

## Task 12: Web API client methods

Add the 5 client methods the settings panel calls.

**Files:**
- Modify: `packages/web/src/lib/api.ts`

**Interfaces:**
- Produces on the `api` object: `getGithubSyncStatus`, `connectGithubSync`, `updateGithubSyncConfig`, `syncGithubNow`, `disconnectGithubSync`.

- [ ] **Step 1: Add the methods**

In the exported `api` object in `packages/web/src/lib/api.ts` (near `updateDepartmentBoard`):

```ts
  getGithubSyncStatus: () =>
    get<{
      connected: boolean; enabled: boolean; projectTitle: string | null;
      department: string | null; pollIntervalSec: number;
      lastPollAt: number | null; lastError: string | null;
    }>("/api/kanban/github/status"),
  connectGithubSync: (body: { token: string; projectUrlOrId: string; department: string }) =>
    post<{ status: string; projectTitle: string; unmatchedColumns: string[]; unmatchedGithub: string[] }>(
      "/api/kanban/github/connect", body),
  updateGithubSyncConfig: (body: { pollIntervalSec?: number; enabled?: boolean; department?: string }) =>
    put<{ status: string }>("/api/kanban/github/config", body),
  syncGithubNow: () =>
    post<{ created: number; updated: number; imported: number; deleted: number; error?: string }>(
      "/api/kanban/github/sync-now", {}),
  disconnectGithubSync: () =>
    post<{ status: string }>("/api/kanban/github/disconnect", {}),
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/web && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): GitHub kanban-sync API client methods"
```

---

## Task 13: Settings UI panel

A "GitHub Projects sync" panel in Settings, following the existing Sessions-panel structure.

**Files:**
- Modify: the settings route/panel file (find the "Sessions" panel added for `interactiveQuestions`; locate with `grep -rn "interactiveQuestions\|Interactive Questions" packages/web/src`). Add a sibling panel component there.

- [ ] **Step 1: Locate the settings panel pattern**

Run: `grep -rn "Interactive Questions\|interactiveQuestions" packages/web/src` and open the file that renders the Sessions settings section. Match its component/section conventions (headings, form controls, save handler).

- [ ] **Step 2: Build the panel state + load**

Add a `GithubSyncPanel` component that, on mount, calls `api.getGithubSyncStatus()` and `api.getOrg()` (for the department dropdown). Store `{ connected, enabled, projectTitle, department, pollIntervalSec, lastPollAt, lastError }` and form fields `token`, `projectUrlOrId`, `department`.

```tsx
const [status, setStatus] = useState<Awaited<ReturnType<typeof api.getGithubSyncStatus>> | null>(null)
const [departments, setDepartments] = useState<string[]>([])
const [token, setToken] = useState("")
const [projectUrlOrId, setProjectUrlOrId] = useState("")
const [department, setDepartment] = useState("")
const [busy, setBusy] = useState(false)
const [notice, setNotice] = useState<string | null>(null)

useEffect(() => {
  void api.getGithubSyncStatus().then(setStatus)
  void api.getOrg().then((o) => setDepartments(o.departments))
}, [])
```

- [ ] **Step 3: Disconnected view (connect form)**

When `!status?.connected`, render token (password), project URL/number, department `<select>` (from `departments`), and a Connect button:

```tsx
async function onConnect() {
  setBusy(true); setNotice(null)
  try {
    const r = await api.connectGithubSync({ token, projectUrlOrId, department })
    setStatus(await api.getGithubSyncStatus())
    const warn = [...r.unmatchedColumns.map((c) => `Jinn column "${c}" has no GitHub status`),
                  ...r.unmatchedGithub.map((g) => `GitHub status "${g}" has no Jinn column`)]
    setNotice(warn.length ? `Connected to ${r.projectTitle}. Heads-up: ${warn.join("; ")}` : `Connected to ${r.projectTitle}.`)
  } catch (e) {
    setNotice(e instanceof Error ? e.message : String(e))
  } finally { setBusy(false) }
}
```

- [ ] **Step 4: Connected view**

When `status?.connected`, show project title, department, an enabled toggle (`api.updateGithubSyncConfig({ enabled })`), a poll-interval number input (min 15, `api.updateGithubSyncConfig({ pollIntervalSec })`), a "Sync now" button (`api.syncGithubNow()` → show the returned counts), a last-sync/error line (`status.lastPollAt`, `status.lastError`), and a Disconnect button (`api.disconnectGithubSync()` → reload status).

```tsx
async function onSyncNow() {
  setBusy(true)
  try {
    const s = await api.syncGithubNow()
    setNotice(s.error ? `Sync error: ${s.error}`
      : `Synced: ${s.created} created, ${s.updated} updated, ${s.imported} imported, ${s.deleted} deleted.`)
    setStatus(await api.getGithubSyncStatus())
  } finally { setBusy(false) }
}
```

- [ ] **Step 5: Render the panel**

Add `<GithubSyncPanel />` into the settings page where the Sessions panel renders.

- [ ] **Step 6: Typecheck + build**

Run: `cd packages/web && pnpm exec tsc --noEmit && pnpm build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): GitHub Projects sync settings panel"
```

---

## Task 14: End-to-end manual verification

Exercise the whole flow against a real (test) GitHub Project.

- [ ] **Step 1: Prep a test Project**

Create a scratch GitHub Project (v2) with a Status field whose options include at least `Backlog`, `In progress`, `Done`. Create a fine-grained PAT with Projects read/write on that Project's owner.

- [ ] **Step 2: Connect**

Run the app, open Settings → GitHub Projects sync, paste the PAT + project URL, pick a department, Connect. Confirm the success notice and any unmatched-column heads-up. Verify `~/.jinn/config.yaml` has the `github` block and `GET /api/config` shows `token: "***"` (redacted).

- [ ] **Step 3: Jinn → GitHub**

Create a ticket in the Jinn kanban in the synced department, move it to "In progress". Within ~2s + poll, confirm a draft item appears on the GitHub Project with the matching Status.

- [ ] **Step 4: GitHub → Jinn**

Add a draft item on GitHub, set its Status. Within one poll interval, confirm it appears in the correct Jinn column. Move it on GitHub; confirm Jinn follows.

- [ ] **Step 5: Delete + conflict**

Delete the ticket in Jinn; confirm the GitHub draft is removed and does not reappear (tombstone). Then edit the same item on both sides between polls; confirm the newer edit wins.

- [ ] **Step 6: Disconnect**

Disconnect in Settings; confirm the `github` block is gone from config and polling stops (check gateway logs).

- [ ] **Step 7: Full test suite green**

Run: `cd packages/jinn && pnpm vitest run && cd ../web && pnpm vitest run`
Expected: all pass.

---

## Self-Review Notes (completed during authoring)

- **Spec coverage:** direction/two-way (Tasks 9, 14), PAT auth + redaction (Tasks 3, 10, 14), draft items (Task 8), fixed 9 columns (Tasks 1, 4), server-side source of truth via board.json (Tasks 2, 5), poll + debounced push (Tasks 9, 11), last-write-wins (Task 7), one-department scope (Tasks 3, 9), sync-state tombstones/pending-deletes (Tasks 6, 9), settings UI (Task 13). All covered.
- **Delete handling (both directions):** implemented via `SyncState.linkedItemIds` (Tasks 6, 9). A remote item that was previously linked but is gone from the local board is a Jinn-side delete → deleted on GitHub + tombstoned; a linked local ticket absent from the remote set is a GitHub-side delete → removed locally; an unknown remote id is a genuine import. This replaces the earlier `pendingDeletes` sketch from the spec, which could not populate itself. Note: crash between `deleteItem` and `saveSyncState` self-heals — on the next poll the item is still remote+previously-linked, so the delete is retried idempotently.
- **Type consistency:** `RemoteItem`, `BoardItem`, `statusOptionIds`, `statusFieldId`, `githubItemId`, `githubSyncedAt` names are consistent across Tasks 3, 5, 7, 8, 9, 10.
