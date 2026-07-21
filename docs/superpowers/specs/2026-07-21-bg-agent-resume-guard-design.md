# Design: Background-Agent Resume Guard

- **Date:** 2026-07-21
- **Status:** Design approved (v1) — implementation to follow
- **Branch:** `feat/bg-agent-resume-guard`

## 1. Problem

jinn spawns `claude --resume <engineSessionId>` (`ensureIdleSpawn`, and `run()`'s
cold path). When Claude Code 2.1.x's agent daemon holds that session as a
`background` agent in state `blocked`/`failed`, claude prints
*"Session <id> is currently running as a background agent (bg). Use `claude agents`
to find and attach to it, or add --fork-session to branch off a copy."* and **exits
immediately**.

The Terminals/CLI viewer's reconnect/resize then re-triggers `ensureIdleSpawn`, so
the PTY dies-and-respawns in a tight loop — each iteration allocates a fresh SSE
proxy (observed: dozens of ports) — and the user sees only the raw refusal text with
no way forward. This has recurred three times in normal task use.

## 2. Root cause

`ensureIdleSpawn` has no notion of "this resume will never succeed." Every viewer
event optimistically re-spawns `--resume`, and nothing detects the daemon's refusal
or surfaces an escape hatch.

## 3. Design (v1)

Four parts, all on existing seams.

### 3.1 Detect the refusal
- Add a stable marker constant `BG_AGENT_MARKER = "running as a background agent"`
  (a substring of claude's message, resilient to id/wording around it).
- In the PTY output tee (`wireProcToStream`), scan output for the marker. On match:
  set `bgAgentBlocked.set(jinnSessionId, engineSessionId)` and push a control event
  (§3.3). Pure, unit-tested detector: `isBgAgentRefusal(chunk: string): boolean`.
- **Backstop (engine-agnostic):** a per-session fast-exit counter — if a PTY exits
  within `FAST_EXIT_MS` (~3s) `FAST_EXIT_LIMIT` (3) times in a row, treat the session
  as blocked too (covers immediate-exit loops from any cause). Pure helper
  `registerExit`/`shouldCircuitBreak` on a small tracker; counter resets on any PTY
  that survives past the window.

### 3.2 Break the loop
- `ensureIdleSpawn` early-returns when `bgAgentBlocked.has(jinnSessionId)` — no
  re-spawn, no new proxy. (`run()`'s spawn is left to fail normally; the loop is the
  viewer path.)
- The flag clears only on an explicit user action (§3.4) — a fresh attempt must be
  deliberate, since a still-blocked session would just re-set the flag.

### 3.3 Surface it
- Extend `PtyControlEvent` from `{ type: "reset" }` to
  `{ type: "reset" } | { type: "bg_agent"; engineSessionId?: string }`.
- Add `PtyStreamManager.pushControl(sessionId, event)` to fan a control event out to
  current subscribers (mirrors the internal `{type:"reset"}` emit on PTY exit).
- `pty-ws` already forwards control events to the client verbatim
  (`onControl → ws.send(JSON.stringify(event))`), so no change needed there for
  delivery.
- The xterm client (`cli-terminal.tsx`) handles `{type:"bg_agent"}`: render an inline
  panel over the terminal — *"This session is running as a background agent (Claude
  Code is holding it in the background)."* — with **[Fork a copy]** and **[Retry]**.

### 3.4 The actions
- **Fork a copy** → reuse the existing `POST /api/sessions/:id/duplicate` endpoint
  (`duplicateSession` + `forkEngineSession`, `--fork-session`) via the existing
  `useDuplicateSession` hook → navigate/select the new session. This is the error's
  own recommended escape and needs no `claude agents` interaction. (The new session
  has its own engine id, so it isn't blocked.)
- **Retry** → the client sends `{type:"retry"}` over the pty WS; `pty-ws` calls
  `engine.clearBgAgentBlock(sessionId)` then re-runs `spawnIfNeeded` at the current
  geometry. For use after the user has cleared the agent in `claude agents`. If still
  blocked, the marker re-sets the flag and the panel returns (no loop — one attempt
  per Retry press).

## 4. Data / API surface changes
- `PtyControlEvent` gains the `bg_agent` variant (backend type + client handling).
- New pty-WS client→server message `{type:"retry"}` (whitelisted in `pty-ws`).
- New engine methods: `clearBgAgentBlock(sessionId)` (and internal `bgAgentBlocked`
  map + fast-exit tracker).
- New `PtyStreamManager.pushControl(sessionId, event)`.
- **Reuses** `POST /api/sessions/:id/duplicate` for Fork — no new HTTP route.

## 5. Non-goals (deferred)
- **Attach** — re-attaching to the live bg agent via Claude's agent-daemon protocol.
  More surface + an undocumented, evolving `claude agents` mechanism; revisit after
  seeing how often "same live agent" is wanted over a fresh fork.
- Auto-clearing the daemon's bg-agent registration from jinn.
- Applying the guard to the non-viewer `run()` turn path beyond letting it fail.

## 6. Testing strategy
- Pure-helper TDD: `isBgAgentRefusal` (marker match / non-match); fast-exit tracker
  (`registerExit` counts within window, resets after a survivor, trips at the limit).
- `PtyStreamManager.pushControl` delivers `{type:"bg_agent"}` to subscribers.
- `ensureIdleSpawn` no-op while `bgAgentBlocked` (mirror the settings-race test
  harness: mocked node-pty + throwaway `JINN_HOME`; assert no spawn occurs).
- `clearBgAgentBlock` re-enables spawning.
- Client panel + Retry/Fork wiring: typecheck + build (page/JSX not unit-tested here).

## 7. Files
- `packages/jinn/src/engines/pty-view-engine.ts` — extend `PtyControlEvent`.
- `packages/jinn/src/engines/pty-stream.ts` — `pushControl`.
- `packages/jinn/src/engines/bg-agent-guard.ts` — **new** pure helpers
  (`isBgAgentRefusal`, fast-exit tracker, constants).
- `packages/jinn/src/engines/claude-interactive.ts` — `bgAgentBlocked` map + tracker,
  detection in `wireProcToStream`, `ensureIdleSpawn` guard, `clearBgAgentBlock`.
- `packages/jinn/src/gateway/pty-ws.ts` — handle `{type:"retry"}`.
- `packages/web/src/components/cli-terminal.tsx` — `{type:"bg_agent"}` panel + actions.

## 8. Test isolation (binding — a prior violation destroyed real data)
Every jinn-package test run uses `export JINN_HOME="$(mktemp -d)"`; DB-touching tests
use a per-file tmp `JINN_HOME` + dynamic `await import`. Subagents never run
destructive commands against `~/.jinn`; on unexpected data, STOP and report.
