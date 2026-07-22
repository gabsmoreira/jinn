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
| Terminals tab | `packages/web/src/routes/terminals/*` (+ tests) | `packages/web/src/lib/nav.ts` (+1 nav entry, +1 icon import) & `nav.test.ts` (overflow-list assertion), `packages/web/src/main.tsx` (+1 import, +1 route) |

The Terminals tab is the low-cost model; the bg-agent guard is the piece most likely to
need touch-ups on a large upstream sync (deep engine seams).

## Sync runbook

```bash
git fetch upstream
git rebase upstream/main personal          # replay our commit stack onto new upstream

# Resolve conflicts — expect them ONLY at the seams:
#   packages/web/src/lib/nav.ts   → re-add the { href: "/terminals", ... } entry
#     (and nav.test.ts → re-add "/terminals" to the overflow-list assertion)
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
