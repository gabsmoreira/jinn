# GitHub Projects ↔ Jinn Kanban Sync — Design (WIP)

> **Status: DRAFT — brainstorming paused 2026-07-16.** One open question remains (see
> "Open question" at the end). Do not start writing the implementation plan until it is
> resolved and the user approves the spec.

## Goal

Two-way synchronization between the Jinn web kanban board and a GitHub Projects v2 board.

## Confirmed decisions

1. **Direction:** Two-way (bidirectional).
2. **GitHub auth:** Fine-grained Personal Access Token (Projects read/write + org read),
   stored in gateway config. The key is named `token`, so it is auto-redacted in
   `GET /api/config` responses via `isSensitiveConfigKey()`.
3. **Item type:** Jinn tickets map to GitHub Project **draft items** (title + body only,
   no repo).
4. **Status mapping baseline:** auto-match Jinn columns to GitHub Status options by
   case-insensitive name, with a settings override — **but see the open question, which
   may reverse this into GitHub-driven columns.**
5. **Data home:** kanban source of truth is server-side on the gateway. *Discovery: this is
   mostly already true* — tickets persist per-department to `~/.jinn/org/<dept>/board.json`
   via `PUT /api/org/departments/:name/board`; the web board already treats the API as the
   sole source of truth on load (localStorage is only an offline mirror).
6. **Trigger:** periodic polling (default 45s, min 15s) + immediate push on local change
   (debounced ~2s off the existing `board:updated` event).
7. **Conflict resolution:** last-write-wins by timestamp (Jinn `updatedAt` vs GitHub item
   `updatedAt`, each compared against the ticket's `githubSyncedAt`).
8. **Sync scope:** one configured department syncs to the one GitHub Project (1:1).

## Architecture

New sync engine module in the gateway: `packages/jinn/src/gateway/github-sync/`. It owns all
GitHub Projects v2 interaction, runs a background poll loop, and reacts to local ticket
changes. The web board is unchanged in behavior — it keeps reading/writing tickets through
the existing department-board API; the engine observes the same server-side board files.

```
Web board ──PUT/GET board.json──► Gateway (api.ts, org/<dept>/board.json)
                                        │ observes + mutates
                                        ▼
                                  github-sync engine
                                  • poll loop (N s)
                                  • push-on-change (debounced)
                                  • name→status map
                                  • last-write-wins resolve
                                  • sync-state.json
                                        │ GraphQL (PAT)
                                        ▼
                                  GitHub Projects v2 (draft items)
```

### Components (each independently testable)

1. **`gql-client.ts`** — thin GitHub GraphQL client. PAT in; typed calls out:
   `listProjectItems`, `createDraftItem`, `updateDraftItem`, `deleteItem`,
   `setStatusField`, `getProjectFields`. Pure I/O, no sync logic.
2. **`mapping.ts`** — pure functions: `KanbanTicket ↔ ProjectItem`, and the
   column↔status-option resolver. No I/O.
3. **`sync-state.ts`** — a `cron/jobs.ts`-style JSON store at
   `~/.jinn/kanban/sync-state.json`. Atomic tmp-write + rename.
4. **`engine.ts`** — the reconciler: poll loop, push-on-change hook, LWW diff, orchestrates
   1–3. The only stateful piece.
5. **Config + API + settings UI** — a `github` block in `JinnConfig`, `/api/kanban/github/*`
   routes, and a Settings panel.

## Data model & storage

### Config (`~/.jinn/config.yaml`, typed in `packages/jinn/src/shared/types.ts`)

```ts
github?: {
  token: string            // fine-grained PAT; auto-redacted in GET /api/config
  projectId: string        // PVT_... resolved at connect time
  projectTitle?: string     // label for settings UI
  department: string        // which department board syncs (1:1)
  pollIntervalSec?: number  // default 45, min 15
  enabled?: boolean         // master on/off
  statusMap?: Partial<Record<TicketStatus, string>>  // column → GitHub Status option name
}
```

`"github"` must be added to the config-PUT `KNOWN_KEYS` whitelist in `api.ts`.

### Ticket link — extend `KanbanTicket` (`packages/web/src/lib/kanban/types.ts`)

```ts
githubItemId?: string    // GitHub draft-item node id, once synced. Absent = never pushed.
githubSyncedAt?: number  // ms timestamp of last successful reconcile for this ticket
```

`sanitizeTicket()` in `store.ts` must be updated to preserve these (it currently drops
unknown keys).

### Sync-state file (`~/.jinn/kanban/sync-state.json`)

```ts
{
  pendingDeletes: string[]    // GitHub item ids deleted locally, not yet on GitHub (crash-safe retry)
  deletedItemIds: string[]    // tombstones: GitHub items whose Jinn ticket was deleted (don't re-import)
  lastPollAt: number | null
  lastError: string | null
}
```

## Sync engine — reconciliation

### Lifecycle
On gateway start and on config hot-reload, if `github.enabled && token && projectId`, start
the poll loop (mirrors the cron scheduler wiring). Config change → stop, restart.

### Reconcile pass (every `pollIntervalSec`, and once on a debounced local change)

1. FETCH GitHub `listProjectItems` → remote[]; READ department `board.json` → local[].
2. MATCH by `githubItemId`: linked (both) / local-only / remote-only.
   - local-only → create draft on GitHub, store `githubItemId` + `githubSyncedAt`.
   - remote-only → import as new ticket (unless in `deletedItemIds`).
3. LINKED → last-write-wins per ticket:
   - `localChanged = updatedAt > githubSyncedAt`; `remoteChanged = remoteUpdatedAt > githubSyncedAt`.
   - only local → push; only remote → apply; both → newer wins whole-ticket + log; neither → skip.
   - status mapped through `statusMap`.
4. DELETES: ticket gone locally (had id) → `deleteItem` + tombstone; linked id absent from
   remote → delete local ticket. `pendingDeletes` makes it crash-safe.
5. WRITE: persist `board.json` (same path the API uses; emit `board:updated` so open clients
   refresh), then save `sync-state.json` with `lastPollAt`.

### Push-on-change
Engine subscribes to the existing `board:updated` event; if the changed department is the
synced one, schedule a reconcile on a ~2s debounce so rapid drag-drops coalesce.

### Safety rails
- **Single-flight:** one reconcile at a time; a trigger mid-run sets a re-run flag.
- **Backoff:** on GitHub error, record `lastError`, skip writes, back off poll (×2 to a cap).
- **Unknown-status guard:** a GitHub status mapping to no Jinn column → drop into `backlog`
  and log; never crash. *(May be moot depending on the open question.)*

## API surface

| Route | Purpose |
|---|---|
| `GET /api/kanban/github/status` | `{ connected, enabled, projectTitle, department, lastPollAt, lastError, statusMap, unmappedColumns }`. Never returns the token. |
| `POST /api/kanban/github/connect` | `{ token, projectUrlOrId, department }` → probe PAT, resolve project id + Status options, auto-build `statusMap`, write config. Returns resolved mapping. |
| `PUT /api/kanban/github/config` | Update `pollIntervalSec` / `enabled` / `department` / corrected `statusMap`; restart engine. |
| `POST /api/kanban/github/sync-now` | Force immediate reconcile; return summary (created/updated/imported/deleted or error). |
| `POST /api/kanban/github/disconnect` | Clear the `github` block. |

Reuse `saveConfigAtomic` + `context.reloadConfig?.()`; `json`/`readJsonBody`/`badRequest`
helpers.

### Web client (`packages/web/src/lib/api.ts`)
Add: `getGithubSyncStatus`, `connectGithubSync`, `updateGithubSyncConfig`, `syncGithubNow`,
`disconnectGithubSync` — via existing `get/post/put` helpers.

### Settings UI (near the existing Sessions panel)
"GitHub Projects sync" panel:
- **Disconnected:** token (password) input, Project URL/number input, department dropdown,
  Connect button.
- **Connected:** project title, department, last-sync/error badge, enabled toggle,
  poll-interval field, Sync-now button, status-mapping table, Disconnect button.

Board page itself: no UI change for v1 (a "last synced" indicator is deferred — YAGNI).

## Open question (BLOCKS completion)

The user said: **"The Jinn should copy the GitHub Status."** This may reverse decision #4 —
instead of mapping Jinn's fixed 5 columns to existing GitHub statuses, the **Jinn board's
columns would become the GitHub Project's Status options** (source of truth = GitHub).

Need to resolve how far this goes:
- (A) **Dynamic columns from GitHub** — board columns ARE the Project's Status options
  (names + order), replacing the fixed Backlog/To Do/In Progress/Review/Done. Requires
  changing `TicketStatus` from a fixed union and `COLUMNS` from a constant to dynamic/
  configured values — significant board refactor.
- (B) **Keep 5 columns, adopt GitHub names** — relabel the 5 to closest GitHub statuses;
  ignore extras.
- (C) **Dynamic only when connected** — fixed 5 by default; switch to GitHub-driven columns
  while connected, revert on disconnect.

Resolving this affects: `types.ts` (`TicketStatus`, `COLUMNS`), `mapping.ts`, the settings
status-mapping table (may disappear entirely under A), and the unknown-status guard.

## Out of scope (v1)
- Real GitHub Issues (draft items only).
- All-departments-merged sync (one department only).
- Webhooks / public callback URL (polling only).
- GitHub App / OAuth (PAT only).
- Manual conflict-resolution UI (last-write-wins is automatic).
