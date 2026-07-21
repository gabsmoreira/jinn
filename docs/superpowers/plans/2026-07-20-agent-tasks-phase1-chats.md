# Agent Tasks — Phase 1 (Chats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the task-first foundation in jinn — home chat per agent + tasks as first-class sessions (role + lifecycle) — and surface it in the Terminals rail and chat sidebar, without changing the underlying one-session-per-task model.

**Architecture:** Additive columns on the existing `sessions` table (a task = a session with a `session_role` + `task_kind` + `lifecycle_state`, NOT a new entity). Lifecycle state is *derived* from `status`/activity by a pure helper, with an explicit override only for `archived`. Home chats are lazily created and protected by a partial unique index. The two UI surfaces consume pure, unit-tested grouping/capping helpers.

**Tech Stack:** TypeScript, better-sqlite3 (jinn gateway), React + Vite (web), vitest.

Spec: `docs/superpowers/specs/2026-07-20-agent-tasks-and-kanban-execution-design.md` (§2.1, §3, §4).

## Global Constraints

- Node **24** (`nvm use 24`); pnpm via corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm ...`).
- **Additive, idempotent migrations only** — new columns are nullable or have literal defaults; never rewrite/backfill existing rows destructively.
- **TDD**: failing test first, watch it fail, minimal code, watch it pass, commit.
- Verify a package with: `nvm use 24 && corepack pnpm -C packages/<pkg> typecheck && corepack pnpm -C packages/<pkg> test`.
- Branch: `feat/agent-tasks-model` (already created). Commit trailers as per repo convention.
- **Legacy rows must migrate cleanly**: `session_role='task'`, `task_kind='execution'`, `lifecycle_state=NULL` (derived).

## Scope

This plan covers spec §4.1 (home chat), §4.3 (Terminals+ surface), §4.4 (sidebar cap), §4.5 (shared helpers), and the data model (§3) + lifecycle/archive-eligibility helpers (§4.2 derivation).

**Deferred to a Phase 1b plan** (they require tracing the engine turn-completion path and the sweep timer — a separate investigation, kept out so this plan stays fully no-placeholder): posting the completion `outcome` line into the home chat, the periodic archive sweep, and explicit archive/done UI actions. Lifecycle still works here because `deriveLifecycleState` computes `done` from `status='idle' + totalTurns>0`; archiving is available programmatically via `updateSession({ lifecycleState: 'archived' })` and wired to UI in 1b.

## File Structure

- `packages/jinn/src/sessions/registry.ts` — add columns to `migrateSessionsSchema`; extend `rowToSession`, `CreateSessionOpts`/`createSession`, `UpdateSessionFields`/`updateSession`; add `getOrCreateHomeChat`; add home partial-unique index.
- `packages/jinn/src/shared/types.ts` — extend `Session`.
- `packages/jinn/src/sessions/task-lifecycle.ts` — **new** pure helpers `deriveLifecycleState`, `isArchiveEligible`.
- `packages/jinn/src/sessions/__tests__/task-lifecycle.test.ts` — **new**.
- `packages/jinn/src/sessions/__tests__/sessions-role-migration.test.ts` — **new** (migration).
- `packages/jinn/src/sessions/__tests__/home-chat.test.ts` — **new**.
- `packages/web/src/routes/terminals/terminal-sessions.ts` — add `groupTerminalsByAgent`.
- `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts` — extend.
- `packages/web/src/components/chat/cap-sessions.ts` — **new** pure `capAgentSessions`.
- `packages/web/src/components/chat/__tests__/cap-sessions.test.ts` — **new**.
- `packages/web/src/routes/terminals/page.tsx` — render grouped rail.
- `packages/web/src/components/chat/chat-sidebar.tsx` — apply cap in `EmployeeRow`.

---

### Task 1: Migration — add task-model columns

**Files:**
- Modify: `packages/jinn/src/sessions/registry.ts` (`migrateSessionsSchema`, ~line 490-516; `initDb` index block ~line 224-226)
- Test: `packages/jinn/src/sessions/__tests__/sessions-role-migration.test.ts`

**Interfaces:**
- Produces: five new nullable columns on `sessions` — `session_role` (default `'task'`), `task_kind` (default `'execution'`), `lifecycle_state`, `brief`, `outcome`; a partial unique index `idx_home_per_agent`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import os from "node:os"; import fs from "node:fs"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-role-mig-"));
process.env.JINN_HOME = tmp;
import { migrateSessionsSchema } from "../registry.js";

describe("migrateSessionsSchema — task-model columns", () => {
  it("adds session_role/task_kind/lifecycle_state/brief/outcome, defaults legacy rows, idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, engine TEXT NOT NULL, source TEXT NOT NULL,
      source_ref TEXT NOT NULL, status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL, last_activity TEXT NOT NULL)`);
    db.prepare(`INSERT INTO sessions (id,engine,source,source_ref,status,created_at,last_activity)
      VALUES ('old-1','claude','web','web:old','idle','t','t')`).run();

    migrateSessionsSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(c => c.name);
    for (const c of ["session_role","task_kind","lifecycle_state","brief","outcome"]) expect(cols).toContain(c);

    const row = db.prepare("SELECT session_role,task_kind,lifecycle_state FROM sessions WHERE id='old-1'").get() as any;
    expect(row.session_role).toBe("task");
    expect(row.task_kind).toBe("execution");
    expect(row.lifecycle_state).toBeNull();

    expect(() => migrateSessionsSchema(db)).not.toThrow();
    const roleCols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).filter(c => c.name === "session_role");
    expect(roleCols.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/sessions-role-migration.test.ts`
Expected: FAIL — `expect(cols).toContain("session_role")` fails (column not added yet).

- [ ] **Step 3: Add the columns to `migrateSessionsSchema`**

In `registry.ts`, extend the `missingColumns` array (after `['prompt_excerpt', 'TEXT']`):

```typescript
    // Task-first model (see docs/.../agent-tasks-and-kanban-execution-design.md §3).
    ['session_role', 'TEXT', "'task'"],
    ['task_kind', 'TEXT', "'execution'"],
    ['lifecycle_state', 'TEXT'],
    ['brief', 'TEXT'],
    ['outcome', 'TEXT'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/sessions-role-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the home partial-unique index in `initDb`**

Add a constant near the other index constants:

```typescript
// One home chat per agent (spec §4.1). Partial unique index — only 'home' rows are constrained.
const CREATE_HOME_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_per_agent ON sessions (employee) WHERE session_role = 'home'
`;
```

In `initDb`, after `db.exec(CREATE_PARENT_INDEX);` (line ~226) add:

```typescript
  db.exec(CREATE_HOME_INDEX);
```

- [ ] **Step 6: Verify + commit**

Run: `corepack pnpm -C packages/jinn typecheck && corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/sessions-role-migration.test.ts`
Expected: typecheck clean, test PASS.

```bash
git add packages/jinn/src/sessions/registry.ts packages/jinn/src/sessions/__tests__/sessions-role-migration.test.ts
git commit -m "feat(sessions): add task-model columns (role/kind/lifecycle/brief/outcome) + home index"
```

---

### Task 2: Session type + read/write plumbing

**Files:**
- Modify: `packages/jinn/src/shared/types.ts` (`Session` interface ~line 199-235)
- Modify: `packages/jinn/src/sessions/registry.ts` (`rowToSession` ~161-194; `CreateSessionOpts` ~528-550; `createSession` INSERT ~588-643; `UpdateSessionFields` ~661-676; `updateSession` ~678-746)
- Test: `packages/jinn/src/sessions/__tests__/home-chat.test.ts` (round-trip portion; home-create added in Task 5)

**Interfaces:**
- Consumes: columns from Task 1.
- Produces:
  - `Session.sessionRole: "home" | "task"`, `Session.taskKind: "execution" | "coordination"`, `Session.lifecycleState: "todo" | "running" | "done" | "archived" | null`, `Session.brief: string | null`, `Session.outcome: string | null`.
  - `CreateSessionOpts.sessionRole?`, `.taskKind?`, `.brief?`.
  - `UpdateSessionFields.lifecycleState?`, `.outcome?`, `.brief?`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import os from "node:os"; import fs from "node:fs"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-task-rw-"));
process.env.JINN_HOME = tmp;
import { createSession, updateSession, getSession } from "../registry.js";

describe("session task-model round-trip", () => {
  it("defaults role=task/kind=execution and persists brief/lifecycle/outcome", () => {
    const s = createSession({ engine: "claude", source: "web", sourceRef: "web:t1", brief: "Add a watchdog" });
    expect(s.sessionRole).toBe("task");
    expect(s.taskKind).toBe("execution");
    expect(s.brief).toBe("Add a watchdog");
    expect(s.lifecycleState).toBeNull();

    updateSession(s.id, { lifecycleState: "archived", outcome: "done, 3 files" });
    const reloaded = getSession(s.id)!;
    expect(reloaded.lifecycleState).toBe("archived");
    expect(reloaded.outcome).toBe("done, 3 files");
  });

  it("can create a home role", () => {
    const s = createSession({ engine: "claude", source: "web", sourceRef: "web:home1", employee: "firmware-lead", sessionRole: "home" });
    expect(s.sessionRole).toBe("home");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/home-chat.test.ts`
Expected: FAIL — `s.sessionRole` is `undefined` (type/plumbing missing).

- [ ] **Step 3: Extend the `Session` interface**

In `types.ts`, inside `interface Session` (after `parentSessionId`):

```typescript
  /** Task-first model (spec §2.1/§3). 'home' = the persistent per-agent chat; 'task' = a unit of work. */
  sessionRole: "home" | "task";
  /** 'execution' = specialist worktree task (Phase 2 gate); 'coordination' = lead that spawns sub-tasks. */
  taskKind: "execution" | "coordination";
  /** Explicit lifecycle override; null means derive from status/activity (see deriveLifecycleState). */
  lifecycleState: "todo" | "running" | "done" | "archived" | null;
  /** The task's well-defined goal (distinct from the auto-generated title). */
  brief: string | null;
  /** Short completion summary (posted to the home chat in Phase 1b). */
  outcome: string | null;
```

- [ ] **Step 4: Extend `rowToSession`, `createSession`, `updateSession`**

`rowToSession` — add to the returned object (before `status:`):

```typescript
    sessionRole: ((row.session_role as string) ?? "task") as Session["sessionRole"],
    taskKind: ((row.task_kind as string) ?? "execution") as Session["taskKind"],
    lifecycleState: ((row.lifecycle_state as string) ?? null) as Session["lifecycleState"],
    brief: (row.brief as string) ?? null,
    outcome: (row.outcome as string) ?? null,
```

`CreateSessionOpts` — add:

```typescript
  sessionRole?: "home" | "task";
  taskKind?: "execution" | "coordination";
  brief?: string;
```

`createSession` — update the INSERT to include the three creation columns. Change the column list + placeholders + `stmt.run(...)`:

```typescript
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, prompt_excerpt, parent_session_id, user_id, effort_level,
      session_role, task_kind, brief, status, created_at, last_activity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);
  stmt.run(
    id, opts.engine, opts.source, opts.sourceRef, connector, sessionKey, replyContext,
    opts.messageId ?? null, transportMeta, opts.employee ?? null, opts.model ?? null, title,
    promptExcerpt, opts.parentSessionId ?? null, opts.userId ?? null, opts.effortLevel ?? null,
    opts.sessionRole ?? "task", opts.taskKind ?? "execution", opts.brief ?? null, now, now,
  );
```

And add to the returned object (before `status: 'idle'`):

```typescript
    sessionRole: opts.sessionRole ?? "task",
    taskKind: opts.taskKind ?? "execution",
    lifecycleState: null,
    brief: opts.brief ?? null,
    outcome: null,
```

`UpdateSessionFields` — add:

```typescript
  lifecycleState?: "todo" | "running" | "done" | "archived" | null;
  outcome?: string | null;
  brief?: string | null;
```

`updateSession` — add three blocks (mirroring the existing `if (updates.X !== undefined)` pattern):

```typescript
  if (updates.lifecycleState !== undefined) { sets.push('lifecycle_state = ?'); values.push(updates.lifecycleState); }
  if (updates.outcome !== undefined) { sets.push('outcome = ?'); values.push(updates.outcome); }
  if (updates.brief !== undefined) { sets.push('brief = ?'); values.push(updates.brief); }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/home-chat.test.ts`
Expected: PASS (both round-trip tests).

- [ ] **Step 6: Verify + commit**

Run: `corepack pnpm -C packages/jinn typecheck && corepack pnpm -C packages/jinn test`
Expected: typecheck clean; full suite green (existing session tests still pass — new columns are additive).

```bash
git add packages/jinn/src/shared/types.ts packages/jinn/src/sessions/registry.ts packages/jinn/src/sessions/__tests__/home-chat.test.ts
git commit -m "feat(sessions): plumb role/kind/lifecycle/brief/outcome through type + create/update"
```

---

### Task 3: `deriveLifecycleState` pure helper

**Files:**
- Create: `packages/jinn/src/sessions/task-lifecycle.ts`
- Test: `packages/jinn/src/sessions/__tests__/task-lifecycle.test.ts`

**Interfaces:**
- Produces: `type TaskLifecycle = 'todo'|'running'|'done'|'archived'`; `deriveLifecycleState(s: { lifecycleState?: string|null; status: string; totalTurns: number }): TaskLifecycle`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { deriveLifecycleState } from "../task-lifecycle.js";

describe("deriveLifecycleState", () => {
  it("running/waiting status → running", () => {
    expect(deriveLifecycleState({ status: "running", totalTurns: 2 })).toBe("running");
    expect(deriveLifecycleState({ status: "waiting", totalTurns: 0 })).toBe("running");
  });
  it("idle with turns → done; idle without turns → todo", () => {
    expect(deriveLifecycleState({ status: "idle", totalTurns: 3 })).toBe("done");
    expect(deriveLifecycleState({ status: "idle", totalTurns: 0 })).toBe("todo");
  });
  it("explicit lifecycleState overrides derivation", () => {
    expect(deriveLifecycleState({ lifecycleState: "archived", status: "running", totalTurns: 5 })).toBe("archived");
    expect(deriveLifecycleState({ lifecycleState: "todo", status: "idle", totalTurns: 9 })).toBe("todo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/task-lifecycle.test.ts`
Expected: FAIL — module `../task-lifecycle.js` not found.

- [ ] **Step 3: Implement**

```typescript
export type TaskLifecycle = "todo" | "running" | "done" | "archived";

/** Derive a task's lifecycle from its status/activity. An explicit `lifecycleState`
 *  (set on the row) always wins — that's how archive (and any manual override) sticks.
 *  Home chats are not tasks; callers should not pass them here. */
export function deriveLifecycleState(s: {
  lifecycleState?: string | null;
  status: string;
  totalTurns: number;
}): TaskLifecycle {
  if (s.lifecycleState === "archived" || s.lifecycleState === "done"
    || s.lifecycleState === "todo" || s.lifecycleState === "running") {
    return s.lifecycleState;
  }
  if (s.status === "running" || s.status === "waiting") return "running";
  return s.totalTurns > 0 ? "done" : "todo";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/task-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/sessions/task-lifecycle.ts packages/jinn/src/sessions/__tests__/task-lifecycle.test.ts
git commit -m "feat(sessions): deriveLifecycleState pure helper"
```

---

### Task 4: `isArchiveEligible` pure helper

**Files:**
- Modify: `packages/jinn/src/sessions/task-lifecycle.ts`
- Test: `packages/jinn/src/sessions/__tests__/task-lifecycle.test.ts`

**Interfaces:**
- Consumes: `deriveLifecycleState` (Task 3).
- Produces: `isArchiveEligible(s: { sessionRole?: string; lifecycleState?: string|null; status: string; totalTurns: number; lastActivity: string }, nowMs: number, idleDays?: number): boolean`.

- [ ] **Step 1: Write the failing test** (append to `task-lifecycle.test.ts`)

```typescript
import { isArchiveEligible } from "../task-lifecycle.js";

describe("isArchiveEligible", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-07-20T00:00:00Z");
  const done = (lastActivity: string) => ({ sessionRole: "task", status: "idle", totalTurns: 4, lastActivity });

  it("done task idle > 7 days → eligible", () => {
    expect(isArchiveEligible(done("2026-07-10T00:00:00Z"), now)).toBe(true);
  });
  it("done task idle < 7 days → not eligible", () => {
    expect(isArchiveEligible(done("2026-07-18T00:00:00Z"), now)).toBe(false);
  });
  it("home chats are never eligible", () => {
    expect(isArchiveEligible({ ...done("2026-01-01T00:00:00Z"), sessionRole: "home" }, now)).toBe(false);
  });
  it("running / not-yet-done tasks are never eligible", () => {
    expect(isArchiveEligible({ sessionRole: "task", status: "running", totalTurns: 1, lastActivity: "2026-01-01T00:00:00Z" }, now)).toBe(false);
    expect(isArchiveEligible({ sessionRole: "task", status: "idle", totalTurns: 0, lastActivity: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });
  it("already archived → not eligible", () => {
    expect(isArchiveEligible({ ...done("2026-01-01T00:00:00Z"), lifecycleState: "archived" }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/task-lifecycle.test.ts`
Expected: FAIL — `isArchiveEligible` is not exported.

- [ ] **Step 3: Implement** (append to `task-lifecycle.ts`)

```typescript
/** A task is archivable when it is a non-home, currently-`done` task whose last
 *  activity is older than `idleDays`. Never archives home chats or live/incomplete work. */
export function isArchiveEligible(
  s: { sessionRole?: string; lifecycleState?: string | null; status: string; totalTurns: number; lastActivity: string },
  nowMs: number,
  idleDays = 7,
): boolean {
  if (s.sessionRole === "home") return false;
  if (s.lifecycleState === "archived") return false;
  if (deriveLifecycleState(s) !== "done") return false;
  const last = Date.parse(s.lastActivity);
  if (Number.isNaN(last)) return false;
  return nowMs - last >= idleDays * 24 * 60 * 60 * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/task-lifecycle.test.ts`
Expected: PASS (all Task 3 + Task 4 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/sessions/task-lifecycle.ts packages/jinn/src/sessions/__tests__/task-lifecycle.test.ts
git commit -m "feat(sessions): isArchiveEligible pure helper (7-day idle default)"
```

---

### Task 5: `getOrCreateHomeChat` + single-home invariant

**Files:**
- Modify: `packages/jinn/src/sessions/registry.ts` (add exported function after `getSessionBySessionKey`, ~line 659)
- Test: `packages/jinn/src/sessions/__tests__/home-chat.test.ts` (append)

**Interfaces:**
- Consumes: `createSession`, `rowToSession`, `initDb` (registry); `CREATE_HOME_INDEX` (Task 1).
- Produces: `getOrCreateHomeChat(employee: string, engine?: string): Session`.

- [ ] **Step 1: Write the failing test** (append to `home-chat.test.ts`)

```typescript
import { getOrCreateHomeChat } from "../registry.js";

describe("getOrCreateHomeChat", () => {
  it("creates one home chat and returns the same one on repeat", () => {
    const a = getOrCreateHomeChat("firmware-lead");
    expect(a.sessionRole).toBe("home");
    expect(a.employee).toBe("firmware-lead");
    const b = getOrCreateHomeChat("firmware-lead");
    expect(b.id).toBe(a.id); // single-home invariant
  });
  it("different agents get different home chats", () => {
    const a = getOrCreateHomeChat("hvac-specialist");
    const b = getOrCreateHomeChat("data-scientist");
    expect(a.id).not.toBe(b.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/home-chat.test.ts`
Expected: FAIL — `getOrCreateHomeChat` not exported.

- [ ] **Step 3: Implement** (in `registry.ts`)

```typescript
/** The single persistent 'home' chat for an agent (spec §4.1). Lazily created; the
 *  partial unique index `idx_home_per_agent` enforces one per agent even under a race
 *  (we re-query on the unique-constraint error). */
export function getOrCreateHomeChat(employee: string, engine = "claude"): Session {
  const db = initDb();
  const find = () =>
    db.prepare(`SELECT * FROM sessions WHERE employee = ? AND session_role = 'home' ORDER BY created_at ASC LIMIT 1`)
      .get(employee) as Record<string, unknown> | undefined;
  const existing = find();
  if (existing) return rowToSession(existing);
  try {
    return createSession({
      engine, source: "web", sourceRef: `home:${employee}`,
      employee, sessionRole: "home", title: `${employee} — home`,
    });
  } catch (err) {
    // Lost a race to the unique index — the other creator won; return theirs.
    const row = find();
    if (row) return rowToSession(row);
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/sessions/__tests__/home-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify full backend + commit**

Run: `corepack pnpm -C packages/jinn typecheck && corepack pnpm -C packages/jinn test`
Expected: typecheck clean; full suite green.

```bash
git add packages/jinn/src/sessions/registry.ts packages/jinn/src/sessions/__tests__/home-chat.test.ts
git commit -m "feat(sessions): getOrCreateHomeChat with single-home invariant"
```

---

### Task 6: `groupTerminalsByAgent` pure helper (web)

**Files:**
- Modify: `packages/web/src/routes/terminals/terminal-sessions.ts`
- Test: `packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts`

**Interfaces:**
- Consumes: `selectTerminalSessions` (existing, same file) for the CLI-engine filter.
- Produces:
  - `interface AgentTerminalGroup<T> { agent: string; home: T | null; visibleTasks: T[]; hiddenCount: number; hasRunning: boolean }`
  - `groupTerminalsByAgent<T extends TerminalRailSession & { id: string; employee?: string; sessionRole?: string; lifecycleState?: string | null }>(sessions: T[], opts?: { cap?: number }): AgentTerminalGroup<T>[]`

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { groupTerminalsByAgent } from "../terminal-sessions";

const t = (id: string, employee: string | undefined, role: string, status: string, act: string, lifecycle?: string) =>
  ({ id, engine: "claude", employee, sessionRole: role, status, lastActivity: act, lifecycleState: lifecycle });

describe("groupTerminalsByAgent", () => {
  it("groups by agent, pins the home chat, and lists non-archived tasks running-first", () => {
    const out = groupTerminalsByAgent([
      t("home", "fw", "home", "idle", "9"),
      t("task-run", "fw", "task", "running", "1"),
      t("task-old", "fw", "task", "idle", "5"),
      t("task-arch", "fw", "task", "idle", "8", "archived"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].agent).toBe("fw");
    expect(out[0].home?.id).toBe("home");
    expect(out[0].visibleTasks.map(x => x.id)).toEqual(["task-run", "task-old"]); // running first; archived dropped
    expect(out[0].hasRunning).toBe(true);
  });

  it("caps visible tasks and reports hiddenCount", () => {
    const many = Array.from({ length: 8 }, (_, i) => t(`x${i}`, "fw", "task", "idle", String(8 - i)));
    const out = groupTerminalsByAgent(many, { cap: 5 });
    expect(out[0].visibleTasks).toHaveLength(5);
    expect(out[0].hiddenCount).toBe(3);
  });

  it("buckets home-less/direct sessions under 'you' and orders running groups first", () => {
    const out = groupTerminalsByAgent([
      t("a", "fw", "task", "idle", "1"),
      t("b", undefined, "task", "running", "2"),
    ]);
    expect(out.map(g => g.agent)).toEqual(["you", "fw"]); // running group floats up
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 24 && corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: FAIL — `groupTerminalsByAgent` not exported.

- [ ] **Step 3: Implement** (append to `terminal-sessions.ts`)

```typescript
export interface AgentTerminalGroup<T> {
  agent: string;
  home: T | null;
  visibleTasks: T[];
  hiddenCount: number;
  hasRunning: boolean;
}

/** Group CLI-capable sessions by agent for the Terminals+ rail: home chat pinned,
 *  non-archived tasks running-first then by activity, capped with a hidden count.
 *  Groups with a running task float to the top. Pure — unit-tested. */
export function groupTerminalsByAgent<
  T extends TerminalRailSession & { id: string; employee?: string; sessionRole?: string; lifecycleState?: string | null },
>(sessions: T[], opts?: { cap?: number }): AgentTerminalGroup<T>[] {
  const cap = opts?.cap ?? 5;
  const filtered = selectTerminalSessions(sessions); // CLI engines, running-first, activity
  const byAgent = new Map<string, T[]>();
  for (const s of filtered) {
    const key = s.employee || "you";
    (byAgent.get(key) ?? byAgent.set(key, []).get(key)!).push(s);
  }
  const groups: AgentTerminalGroup<T>[] = [];
  for (const [agent, rows] of byAgent) {
    const home = rows.find((r) => r.sessionRole === "home") ?? null;
    const tasks = rows.filter((r) => r.sessionRole !== "home" && r.lifecycleState !== "archived");
    groups.push({
      agent,
      home,
      visibleTasks: tasks.slice(0, cap),
      hiddenCount: Math.max(0, tasks.length - cap),
      hasRunning: rows.some((r) => r.status === "running"),
    });
  }
  const activity = (g: AgentTerminalGroup<T>) =>
    (g.home?.lastActivity || g.visibleTasks[0]?.lastActivity || "");
  groups.sort((a, b) => {
    if (a.hasRunning !== b.hasRunning) return a.hasRunning ? -1 : 1;
    return activity(b).localeCompare(activity(a));
  });
  return groups;
}
```

> Note: `selectTerminalSessions` already sorts running-first then by activity, so `visibleTasks` inherits that order; we only re-bucket and cap.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/web exec vitest run src/routes/terminals/__tests__/terminal-sessions.test.ts`
Expected: PASS (existing `selectTerminalSessions` tests + new group tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/terminals/terminal-sessions.ts packages/web/src/routes/terminals/__tests__/terminal-sessions.test.ts
git commit -m "feat(web/terminals): groupTerminalsByAgent pure helper (home pinned, tasks capped)"
```

---

### Task 7: `capAgentSessions` pure helper (chat sidebar)

**Files:**
- Create: `packages/web/src/components/chat/cap-sessions.ts`
- Test: `packages/web/src/components/chat/__tests__/cap-sessions.test.ts`

**Interfaces:**
- Produces: `capAgentSessions<T extends { id: string }>(sorted: T[], opts: { cap: number; activeId?: string | null; isPinned?: (s: T) => boolean }): { visible: T[]; hiddenCount: number }` — always includes the active + pinned sessions even when they fall past the cap.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { capAgentSessions } from "../cap-sessions";

const s = (id: string) => ({ id });

describe("capAgentSessions", () => {
  it("caps to N and reports the remainder", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 2 });
    expect(out.visible.map(x => x.id)).toEqual(["a", "b"]);
    expect(out.hiddenCount).toBe(2);
  });
  it("always includes the active session even past the cap", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 2, activeId: "d" });
    expect(out.visible.map(x => x.id)).toContain("d");
    expect(out.hiddenCount).toBe(1); // c still hidden
  });
  it("always includes pinned sessions past the cap", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 1, isPinned: (x) => x.id === "c" });
    expect(out.visible.map(x => x.id)).toEqual(["a", "c"]);
    expect(out.hiddenCount).toBe(2); // b, d hidden
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm -C packages/web exec vitest run src/components/chat/__tests__/cap-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/** Cap a per-agent session list to `cap` items while ALWAYS surfacing the active and
 *  any pinned sessions (so the user never loses their place). Preserves input order.
 *  Returns the visible slice + how many are hidden. Pure — unit-tested. */
export function capAgentSessions<T extends { id: string }>(
  sorted: T[],
  opts: { cap: number; activeId?: string | null; isPinned?: (s: T) => boolean },
): { visible: T[]; hiddenCount: number } {
  const { cap, activeId, isPinned } = opts;
  if (sorted.length <= cap) return { visible: sorted, hiddenCount: 0 };
  const mustKeep = new Set<string>();
  for (const s of sorted) {
    if (s.id === activeId) mustKeep.add(s.id);
    if (isPinned?.(s)) mustKeep.add(s.id);
  }
  const visible: T[] = [];
  for (const s of sorted) {
    if (visible.length < cap || mustKeep.has(s.id)) visible.push(s);
  }
  return { visible, hiddenCount: sorted.length - visible.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/web exec vitest run src/components/chat/__tests__/cap-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/chat/cap-sessions.ts packages/web/src/components/chat/__tests__/cap-sessions.test.ts
git commit -m "feat(web/chat): capAgentSessions pure helper (keeps active + pinned)"
```

---

### Task 8: Render the Terminals+ grouped rail

**Files:**
- Modify: `packages/web/src/routes/terminals/page.tsx`

**Interfaces:**
- Consumes: `groupTerminalsByAgent` (Task 6). Session objects from `useSessions()` already carry `employee`, `status`, `lastActivity`; add `sessionRole`/`lifecycleState` to the local `TermSession` type (they flow from the gateway serialization once Task 2 lands).

- [ ] **Step 1: Extend the local type + build groups**

In `page.tsx`, extend `interface TermSession` with:

```typescript
  sessionRole?: string
  lifecycleState?: string | null
```

Replace the `sessions` memo:

```typescript
  const groups = useMemo(
    () => groupTerminalsByAgent((rawSessions ?? []) as unknown as TermSession[], { cap: 5 }),
    [rawSessions],
  )
```

Import it: `import { groupTerminalsByAgent } from './terminal-sessions'` (keep `selectTerminalSessions` import only if still used elsewhere; otherwise remove).

- [ ] **Step 2: Render groups in the rail**

Replace the rail body (the `sessions.map(...)` block) with grouped rendering. Each group renders: an agent header, the pinned home row, then `visibleTasks`, then a "+N more" affordance when `hiddenCount > 0`. Keep the existing `StatusDot`, `EmployeeAvatar`, `titleCase`, and the `selectedId`/`setSelectedId` selection model. Example:

```tsx
{groups.map((g) => {
  const label = g.agent === "you" ? "You" : titleCase(g.agent)
  const name = g.agent === "you" ? "you" : g.agent
  return (
    <div key={g.agent} className="pb-1">
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <EmployeeAvatar name={name} size={20} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">{label}</span>
        {g.hasRunning ? <StatusDot status="running" /> : null}
      </div>
      {g.home ? (
        <RailRow s={g.home} selected={g.home.id === selectedId} onSelect={setSelectedId} label="💬 Home chat" />
      ) : null}
      {g.visibleTasks.map((s) => (
        <RailRow key={s.id} s={s} selected={s.id === selectedId} onSelect={setSelectedId} />
      ))}
      {g.hiddenCount > 0 ? (
        <div className="px-9 py-1 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">+{g.hiddenCount} more</div>
      ) : null}
    </div>
  )
})}
```

Extract the existing per-row button into a small local `RailRow` component (moving the current `<button>` JSX into it, keyed by `s.id`, showing `StatusDot` + title/`promptExcerpt`). Update the "keep a valid selection" effect to derive the candidate id list from `groups` (`groups.flatMap(g => [g.home?.id, ...g.visibleTasks.map(t => t.id)]).filter(Boolean)`) instead of `sessions`.

- [ ] **Step 3: Verify (typecheck + build; UI rendering isn't unit-tested in this codebase — the logic lives in the tested helper)**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: both clean.

- [ ] **Step 4: Manual check**

Run the dev build (`jinn-dev stop; jinn-dev start`), open **/terminals**: agents are grouped, each shows a pinned "💬 Home chat" row, active tasks running-first, and "+N more" when an agent has >5 tasks. Selecting any row focuses its terminal on the right.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/terminals/page.tsx
git commit -m "feat(web/terminals): agent-grouped rail with pinned home chat + capped tasks"
```

---

### Task 9: Apply the cap in the chat sidebar

**Files:**
- Modify: `packages/web/src/components/chat/chat-sidebar.tsx` (`EmployeeRow` render — the `isExpanded && loadedCount > 1` block ~line 960-971)

**Interfaces:**
- Consumes: `capAgentSessions` (Task 7). A `SIDEBAR_CHATS_PER_AGENT = 5` constant.

- [ ] **Step 1: Add the constant + local reveal state**

Near the top of `chat-sidebar.tsx` (with the other module constants):

```typescript
const SIDEBAR_CHATS_PER_AGENT = 5
```

In `EmployeeRow`, add local state for the in-group reveal:

```typescript
const [revealedAll, setRevealedAll] = useState(false)
```

- [ ] **Step 2: Cap the rendered sessions**

Replace the expanded-sessions block (currently `empSessions.map(...)`) with a capped slice that always keeps the active + pinned chats:

```tsx
{isExpanded && loadedCount > 1 ? (() => {
  const { visible, hiddenCount } = revealedAll
    ? { visible: empSessions, hiddenCount: 0 }
    : capAgentSessions(empSessions, {
        cap: SIDEBAR_CHATS_PER_AGENT,
        activeId: selectedId,
        isPinned: (s) => pinnedSessions.has(s.id),
      })
  return (
    <>
      {visible.map((session) => (
        <SessionRow key={session.id} session={session} parentSessions={empSessions} {...sessionRowProps} />
      ))}
      {hiddenCount > 0 ? (
        <button
          onClick={() => setRevealedAll(true)}
          className="w-full px-11 py-1.5 text-left text-[length:var(--text-caption2)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </>
  )
})() : null}
```

Import `capAgentSessions` from `./cap-sessions`. Keep the existing **server** load-more block (`isExpanded && loadedCount < sessionCount`, ~line 965) untouched — it fetches un-loaded rows and is orthogonal to this local cap (local reveal shows already-loaded rows first; the server "+N more" still appears when the server has more than are loaded).

- [ ] **Step 3: Verify (typecheck + build; cap logic is covered by Task 7's unit tests)**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: both clean.

- [ ] **Step 4: Manual check**

Open the chat sidebar, expand a chatty agent: at most 5 chats show (plus the active/pinned ones), with "+N more" revealing the rest locally; the server load-more still works when the group has un-loaded chats.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/chat/chat-sidebar.tsx
git commit -m "feat(web/chat): cap chats per agent group (~5 + local show-more, keeps active/pinned)"
```

---

## Phase 1b (follow-up plan — not in this plan)

These need tracing the engine turn-completion path and the sweep timer, so they get their own plan once we locate the exact hooks:
- **Outcome → home chat:** on task completion, write a one-line `outcome` and post it as an activity entry into the agent's home chat.
- **Archive sweep:** a periodic pass calling `isArchiveEligible` → `updateSession({ lifecycleState: "archived" })`.
- **Explicit UI actions:** "Archive" / "Mark done" on a task; "Delegate task" from a home chat.

## Self-review notes

- **Spec coverage:** §3 data model → Tasks 1-2; §4.1 home chat → Tasks 1 (index) + 5; §4.2 lifecycle derivation + archive-eligibility → Tasks 3-4 (auto-done/sweep/outcome deferred to 1b, explicitly); §4.3 Terminals+ → Tasks 6 + 8; §4.4 sidebar cap → Tasks 7 + 9; §4.5 shared helpers → Tasks 6, 7. §2.1 `task_kind`/`session_role`/assignee(`employee`) columns → Tasks 1-2.
- **Type consistency:** `session_role`/`sessionRole`, `task_kind`/`taskKind`, `lifecycle_state`/`lifecycleState` used consistently DB↔type; `deriveLifecycleState`/`isArchiveEligible`/`groupTerminalsByAgent`/`capAgentSessions` signatures match across producer/consumer tasks.
- **No placeholders:** every code step contains complete code; UI tasks (8, 9) verify via typecheck+build+manual because this codebase unit-tests the extracted pure helpers, not JSX rendering.
