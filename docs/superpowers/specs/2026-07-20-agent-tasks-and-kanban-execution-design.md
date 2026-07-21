# Design: Agent Tasks, Home Chats & Kanban Autonomous Execution

- **Date:** 2026-07-20
- **Status:** Design approved — implementation to follow in two phases
- **Branch:** `feat/agent-tasks-model`

## 1. Problem

jinn creates one session per conversation/task, and sessions never close — they go
`idle` and live forever. A specialist agent therefore accumulates a new session for
every task delegated to it. (Verified: `thermostat-firmware` had **8 distinct
sessions** over 6 days — 8 distinct engine sessions, 8 distinct titles, 8 distinct
parents. Not duplicates: genuinely separate delegated tasks.)

Consequences:
- The chat sidebar dumps **every** loaded chat under an agent when expanded
  (`chat-sidebar.tsx:960` maps all `empSessions` with no display cap; the "+N more"
  button *loads more* rather than trimming).
- The Terminals rail is a **flat list of all CLI sessions** (`routes/terminals/page.tsx`),
  many per agent.
- There is no notion of an ongoing *relationship* with an agent vs. a discrete *unit
  of work*, and no lifecycle to retire finished work.

## 2. Mental model (decided)

The user is a software+firmware engineer and thinks **task-first**.

- **Home chat** = the persistent relationship with an agent. One per agent. Where you
  set direction, ask status, and read an activity log. Never archived.
- **Task** = a discrete, well-defined unit of work. First-class, with a lifecycle.
  Each task is its own isolated session. Tasks are the primary thing you work with.

**Hard constraint driving the model:** a single `claude` conversation runs one turn at
a time (the engine's `active` map is keyed per session), so parallel delegation to one
agent *requires* separate sessions. We therefore **keep per-task isolation** (for
parallelism + clean audit) and fix the human-facing surface + lifecycle instead. The
proliferation is a navigation/lifecycle problem, not a data-model problem.

### 2.1 Agents, leads & the task tree (assignment model)

**Leads are optional coordinators, never mandatory routers.** Two hierarchies coexist:

- **Org hierarchy (people)** — who reports to whom (`org/<dept>/board.json`). Persistent.
  Provides *defaults and suggestions* for assignment, nothing more.
- **Task tree (work)** — who spawned this unit of work, per task, via the existing
  `parent_session_id` link. May or may not follow the org hierarchy.

**A task is assignable to any agent** (the existing `employee` column). Assign directly to
a specialist when the work is concrete and single-owner; assign to a lead when it needs
decomposition, routing, cross-specialist coordination, or domain review. **Routing through
a lead is never enforced** — bypassing it is a first-class path, and it *is* the default
for clear single-owner work (a lead would be pure overhead there).

**Two kinds of task** (`task_kind`), with different done-gates:
- **`execution`** (typically a specialist) — implements in an isolated worktree; gated by
  the objective **acceptance command** (Phase 2, §5.3).
- **`coordination`** (typically a lead) — decomposes the goal, spawns specialist
  **sub-tasks** (children in the task tree), tracks + reviews them, and reports one
  aggregated outcome up to its home chat. Its gate = **all child tasks passed their gates
  + the lead's review** — the AND of its children's gates, not a build command.

## 3. Data model (additive — reuse the `sessions` table)

A "task" is **not** a new entity — it is a session with a role + lifecycle. Add columns
to `sessions` (jinn's migration style is additive + tested):

| column | values | notes |
|---|---|---|
| `session_role` | `home` \| `task` | default `task`; NULL treated as `task` for legacy rows. Exactly one `home` per agent. |
| `task_kind` | `execution` \| `coordination` | default `execution`. Coordination tasks (leads) spawn sub-tasks; gate = children passed + review (see §2.1). |
| `lifecycle_state` | `todo` \| `running` \| `done` \| `archived` | derived from `status`/activity where possible; explicit for archive. |
| `brief` | text | the task's well-defined goal (distinct from auto-generated `title`). |
| `outcome` | text | short completion summary posted into the home chat. |
| `target_repo` (P2) | text | repo the task operates on. |
| `base_branch` (P2) | text | branch the worktree is cut from. |
| `worktree_path` (P2) | text | isolated worktree for this task. |
| `acceptance_command` (P2) | text | objective done-gate (required). |
| `pr_url` (P2) | text | PR opened on green. |
| `attempts` (P2) | int | self-repair attempts used. |

Legacy rows migrate to `role=task`, `task_kind=execution`, `lifecycle_state` derived from
`status`. Home chats are created lazily (see 4.1). **Assignee** = the existing `employee`
column (any agent); **the task tree** = the existing `parent_session_id` link (a
coordination task's children point to it). No new tables.

---

## 4. Phase 1 — Task model + per-agent "Terminals+" surface (the "chats")

Build first. Useful on its own; de-risks Phase 2.

### 4.1 Home chat per agent
- One persistent session per agent, `role='home'`, auto-created lazily the first time an
  agent with no home chat is opened (or at agent creation). Single-home invariant.
- Never archived; always the pinned top row of the agent's group.
- The direct/"you" bucket keeps its existing `DIRECT_GROUP` behavior.

### 4.2 Task as first-class + hybrid archiving (decided)
- Existing delegated/web sessions become tasks (`role='task'`) with a `lifecycle_state`.
- **Auto-mark `done`** when the task's turn completes and it goes idle (that's just a fact).
- **Archive** either explicitly (an "Archive" action) **or** automatically after a long
  idle window (**default 7 days idle**). Nothing you might revisit vanishes; stale work
  clears itself.
- Archived = out of the active view, still **resumable + searchable**.
- On completion, post a one-line `outcome` into the agent's home chat as an activity
  entry (e.g. `✅ #38 fw-safety — done, 3 files → open`). Home chat stays a clean log; no
  transcript bloat.

### 4.3 Surface: "Terminals+" per-agent rail (chosen layout)
Agent-grouped rail; each agent expands to:
- 💬 **Home chat** (pinned).
- ▶ **Active tasks** (running-first).
- **Recent done** (cap ~5) → **+N archived** (collapsed, resumable, searchable).

Group order: agents with a running task first, then most-recent activity. Right pane =
the focused interactive `<CliTerminal interactive />` (unchanged).

### 4.4 Chat sidebar cap
Cap ~5 recent chats per agent group + a **local** "+N more" (reveals already-loaded rows;
then falls through to the existing **server** load-more at `chat-sidebar.tsx:965`).
Active + pinned chats always shown. `SIDEBAR_CHATS_PER_AGENT = 5`.

### 4.5 Shared building block
Factor "cap N + show more" + agent-grouping into one hook/component reused by the chat
sidebar and the Terminals+ rail. Pure, unit-tested helper `groupTerminalsByAgent(sessions,
{ cap })` alongside `selectTerminalSessions`.

### 4.6 Files
- `packages/jinn/src/sessions/registry.ts` — migration, columns, queries.
- `packages/jinn/src/sessions/*` — lazy home-chat create; lifecycle transitions; archive sweep.
- `packages/web/src/routes/terminals/*` — grouped rail, home pinned, task lifecycle rendering.
- `packages/web/src/components/chat/chat-sidebar.tsx` — cap + show-more.
- Engine completion path → registry write → home-chat activity entry (outcome).

---

## 5. Phase 2 — Kanban autonomous execution

Builds on Phase 1's first-class tasks.

### 5.1 Launch flow
Kanban card → **Launch** → task-create form: **brief + target repo + base branch +
acceptance command (required)** → creates a `role='task'` session with the P2 fields, an
isolated worktree, and runs the agent autonomously.

### 5.2 Isolated git worktree (per task)
- On launch: `git worktree add <path> -b task/<id> <base_branch>` in the target repo;
  agent spawned with `cwd = worktree_path` (jinn's spawn already accepts `cwd`).
- Branch-per-task → no clobbering `main`/other tasks; **true parallelism**; clean diff.
- Lifecycle: worktree bound to the task; removed on archive **only if no unmerged
  changes** (guard) — otherwise kept + flagged. Cleanup tied to the hybrid archive.

### 5.3 Acceptance gate (required primary — decided)
- Each task carries `acceptance_command` (e.g. `pnpm test && pnpm build && pnpm
  typecheck`, or firmware `make && run-hil-tests`).
- After the agent's implementation turn, run the command in the worktree. **Exit 0 =
  pass = done.** The agent cannot fake this — it is the objective definition of done.
- Reviewer-agent as a *secondary* check for fuzzy/no-test tasks is a **later** option,
  not in the MVP.
- **Execution vs coordination gates:** the command gate above applies to `execution`
  tasks. A `coordination` task (a lead) has no command — it is done when **all its child
  tasks have passed their gates** and the lead's review is satisfied (see §2.1).

### 5.4 Card lifecycle + bounded self-repair
`To-do → Running (worktree + agent) → Validating (gate) → Done (pass) / Blocked (fail)`.
On fail: bounded self-repair loop (read failures → fix → re-run), up to **N attempts or a
per-task budget** → still failing → **Blocked + notify**. `attempts` tracked.

### 5.5 On green: PR for review (decided — no auto-merge)
Push the branch + open a PR (or produce a diff/branch link); move card to Done.
**No auto-merge to `main`** — human reviews the diff. Auto-merge is an explicit future opt-in.

### 5.6 Safety: budget + kill switch (load-bearing)
- Enforce `maxCostUsd` / `maxDurationMinutes` — jinn parses these but does **not** enforce
  them today; enforcement becomes required for autonomy.
- Per-task kill switch; move to Blocked on budget exceed.

### 5.7 Files
- Worktree lifecycle: new module (reuse `sessions/fork.ts` patterns + shared PTY env).
- Acceptance runner: run command in worktree, capture result → lifecycle transition.
- `packages/web/src/routes/kanban/*` — Launch button + task-create form + lifecycle columns.
- Budget enforcement: engine run path + per-task budget guard.

---

## 6. Non-goals / deferred
- Auto-merge to `main` (PR-for-review only initially).
- Reviewer-agent as the primary gate (command gate is primary; reviewer optional later).
- Budget UI polish / org-wide budget dashboards.
- Task threading / merging multiple tasks into one session.

## 7. Risks
- **The acceptance gate is make-or-break** — without a real command it is theater. Make it required.
- Worktree cleanup + disk; the unmerged-changes guard is essential.
- Parallel tasks → merge conflicts at review time (human-in-loop merge handles it).
- Autonomy without budget/kill = runaway cost — enforce before shipping Phase 2.
- Base-branch drift: worktree cuts at launch; rebase/merge handled at review.

## 8. Testing strategy
- Pure-helper TDD: `groupTerminalsByAgent`, lifecycle-state derivation, archive-eligibility,
  acceptance-result parsing.
- Migration test: additive columns, legacy rows default correctly.
- Home-chat lazy-create + single-home invariant.
- Worktree lifecycle (create / unmerged-guard / remove) against a temp git repo.
- Self-repair loop bounds (stops at N attempts / budget).

## 9. Sequencing
1. **Phase 1 (chats)** — task model + home chats + Terminals+ surface + sidebar cap. Ship + use.
2. **Phase 2 (Kanban autonomous)** — launch + worktree + acceptance gate + PR flow + budget.
