# GitHub Projects ↔ Jinn Kanban Sync — Design

> **Status: DRAFT — ready for user review (2026-07-17).** Open question resolved:
> Jinn uses a fixed set of columns that mirror the GitHub Project's Status options by
> name; no dynamic column syncing.

## Goal

Two-way synchronization between the Jinn web kanban board and a GitHub Projects v2 board.

## Confirmed decisions

1. **Direction:** Two-way (bidirectional).
2. **GitHub auth:** Fine-grained Personal Access Token (Projects read/write + org read),
   stored in gateway config. The key is named `token`, so it is auto-redacted in
   `GET /api/config` responses via `isSensitiveConfigKey()`.
3. **Item type:** Jinn tickets map to GitHub Project **draft items** (title + body only,
   no repo).
4. **Columns:** Jinn's board uses a **fixed set of 9 columns that mirror the GitHub
   Project's Status options by name** (see below). No dynamic column resolution, no
   per-project mapping table — the column names ARE the GitHub Status names, so sync is a
   1:1 name match.
5. **Data home:** kanban source of truth is server-side on the gateway. *Discovery: this is
   mostly already true* — tickets persist per-department to `~/.jinn/org/<dept>/board.json`
   via `PUT /api/org/departments/:name/board`; the web board already treats the API as the
   sole source of truth on load (localStorage is only an offline mirror).
6. **Trigger:** periodic polling (default 45s, min 15s) + immediate push on local change
   (debounced ~2s off the existing `board:updated` event).
7. **Conflict resolution:** last-write-wins by timestamp (Jinn `updatedAt` vs GitHub item
   `updatedAt`, each compared against the ticket's `githubSyncedAt`).
8. **Sync scope:** one configured department syncs to the one GitHub Project (1:1).

## Columns

The board's columns are replaced by this fixed, ordered set. Each column's **display name
matches a GitHub Status option exactly** (the string used for name-based sync matching):

| # | Display name (= GitHub Status) | `TicketStatus` slug |
|---|---|---|
| 1 | Backlog | `backlog` |
| 2 | Ready | `ready` |
| 3 | Backlog \| Week Goal | `backlog-week-goal` |
| 4 | In progress | `in-progress` |
| 5 | In review | `in-review` |
| 6 | Backlog \| Testing | `backlog-testing` |
| 7 | Testing | `testing` |
| 8 | Ready to release | `ready-to-release` |
| 9 | Done | `done` |

These fully replace the previous `backlog/todo/in-progress/review/done` columns.

- `TicketStatus` (`packages/web/src/lib/kanban/types.ts`) becomes the union of the 9 slugs.
- `COLUMNS` becomes the ordered list of `{ id: slug, title: displayName }`.
- A `STATUS_TO_GITHUB` map (slug → exact GitHub Status name) and its inverse live alongside
  `COLUMNS`; the gateway sync engine uses the same table (shared or duplicated in
  `packages/jinn`). Since names are identical to titles, this table is effectively
  `title`↔`slug`.
- **Migration:** existing tickets in the old 5-status scheme are remapped once on load
  (`todo → ready`, `review → in-review`, others by same name; anything unknown → `backlog`).
  `sanitizeTicket()` performs this coercion so old localStorage / board.json data is safe.

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
                                  • name-based status match (1:1)
                                  • last-write-wins resolve
                                  • sync-state.json
                                        │ GraphQL (PAT)
                                        ▼
                                  GitHub Projects v2 (draft items)
```

### Components (each independently testable)

1. **`gql-client.ts`** — thin GitHub GraphQL client. PAT in; typed calls out:
   `listProjectItems`, `createDraftItem`, `updateDraftItem`, `deleteItem`,
   `setStatusField`, `getProjectFields` (to resolve the Status field id + option ids). Pure
   I/O, no sync logic.
2. **`mapping.ts`** — pure functions: `KanbanTicket ↔ ProjectItem`, and the
   status-slug ↔ GitHub-Status-option-id resolver (matched by exact name at connect time,
   then addressed by option id). No I/O.
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
  statusFieldId?: string    // resolved GitHub Status field node id
  statusOptionIds?: Record<string, string>  // TicketStatus slug → GitHub Status option id
  pollIntervalSec?: number  // default 45, min 15
  enabled?: boolean         // master on/off
}
```

`"github"` must be added to the config-PUT `KNOWN_KEYS` whitelist in `api.ts`. The
`statusOptionIds` map is resolved once at connect time by matching each column's display
name to a Project Status option name; a Status option present on GitHub but not in Jinn's 9
is ignored, and vice-versa (logged as a warning at connect).

### Ticket link — extend `KanbanTicket` (`packages/web/src/lib/kanban/types.ts`)

```ts
githubItemId?: string    // GitHub draft-item node id, once synced. Absent = never pushed.
githubSyncedAt?: number  // ms timestamp of last successful reconcile for this ticket
```

`sanitizeTicket()` in `store.ts` must preserve these (it currently drops unknown keys) and
also perform the old→new status migration described under "Columns".

### Sync-state file (`~/.jinn/kanban/sync-state.json`)

```ts
{
  pendingDeletes: string[]    // GitHub item ids deleted locally, not yet on GitHub (crash-safe retry)
  deletedItemIds: string[]    // tombstones: GitHub items whose Jinn ticket was deleted (don't re-import)
  lastPollAt: number | null
  lastError: string | null
}
```

**Why last-write-wins needs no extra storage:** each side carries a modified timestamp —
Jinn's `updatedAt` and the GitHub item `updatedAt`. On reconcile, compare each against the
ticket's `githubSyncedAt`: whichever changed since last sync wins; if both did, the newer
timestamp wins field-by-field.

## Sync engine — reconciliation

### Lifecycle
On gateway start and on config hot-reload, if `github.enabled && token && projectId`, start
the poll loop (mirrors the cron scheduler wiring). Config change → stop, restart.

### Reconcile pass (every `pollIntervalSec`, and once on a debounced local change)

1. FETCH GitHub `listProjectItems` → remote[]; READ department `board.json` → local[].
2. MATCH by `githubItemId`: linked (both) / local-only / remote-only.
   - local-only → create draft on GitHub, set its Status option, store `githubItemId` +
     `githubSyncedAt`.
   - remote-only → import as new ticket (unless in `deletedItemIds`); map its Status option
     id → Jinn slug.
3. LINKED → last-write-wins per ticket:
   - `localChanged = updatedAt > githubSyncedAt`; `remoteChanged = remoteUpdatedAt > githubSyncedAt`.
   - only local → push; only remote → apply; both → newer wins whole-ticket + log; neither → skip.
   - status resolved via `statusOptionIds` (slug ↔ option id).
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
- **Unmapped Status option:** a GitHub item whose Status option id isn't in `statusOptionIds`
  (e.g. a GitHub-only status not among Jinn's 9) → import into `backlog` and log; never crash.

## API surface

| Route | Purpose |
|---|---|
| `GET /api/kanban/github/status` | `{ connected, enabled, projectTitle, department, lastPollAt, lastError, unmatchedStatuses }`. Never returns the token. |
| `POST /api/kanban/github/connect` | `{ token, projectUrlOrId, department }` → probe PAT, resolve project id + Status field/options, match the 9 column names to option ids (`statusOptionIds`), write config. Returns any Jinn columns or GitHub statuses that didn't match, for a heads-up. |
| `PUT /api/kanban/github/config` | Update `pollIntervalSec` / `enabled` / `department`; restart engine. |
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
  poll-interval field, Sync-now button, Disconnect button. If any of the 9 columns didn't
  match a GitHub Status (or vice-versa), show a non-blocking warning listing them.

Board page: columns update to the fixed 9. No other board UI change for v1 (a "last synced"
indicator is deferred — YAGNI).

## Error handling
- PAT invalid / lacking scope → `connect` returns a clear 400; engine never starts.
- GitHub rate limit / 5xx → recorded in `lastError`, surfaced in the status badge; poll backs
  off, no local writes lost.
- Corrupt `board.json` / `sync-state.json` → follow the `cron/jobs.ts` precedent (copy aside
  as `.corrupt-<ts>`, continue with empty state).
- Torn config writes avoided via `saveConfigAtomic` (tmp + rename).

## Testing
- **`mapping.ts`** — pure unit tests: ticket↔item, slug↔option-id, old→new status migration,
  unmapped-status fallback.
- **`sync-state.ts`** — load/save round-trip, ENOENT → empty, corrupt → quarantine.
- **`engine.ts`** — reconcile against a faked `gql-client`: local-only create, remote-only
  import, linked LWW (each branch), both-sides conflict, deletes both directions, tombstone
  suppression, single-flight, backoff on error.
- **API routes** — connect validation, redaction of `token` in status/config GETs.
- **Web** — `sanitizeTicket` migration; board renders the 9 columns; settings connect flow.

## Out of scope (v1)
- Real GitHub Issues (draft items only).
- All-departments-merged sync (one department only).
- Dynamic columns from arbitrary Projects (columns are the fixed 9).
- Webhooks / public callback URL (polling only).
- GitHub App / OAuth (PAT only).
- Manual conflict-resolution UI (last-write-wins is automatic).
