# Background-Agent Resume Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop jinn's `--resume` re-spawn loop when Claude Code 2.1.x refuses a resume because the session is held as a background agent, and give the user an inline Fork/Retry escape instead of a raw error.

**Architecture:** Detect the "running as a background agent" refusal (plus a fast-exit backstop) in the PTY output tee; flag the session so `ensureIdleSpawn` stops re-spawning; push a new `{type:"bg_agent"}` control event to the xterm client, which renders a Fork/Retry panel. Fork reuses the existing duplicate endpoint; Retry clears the flag and re-spawns.

**Tech Stack:** TypeScript, node-pty, better-sqlite3, React + Vite, vitest.

Spec: `docs/superpowers/specs/2026-07-21-bg-agent-resume-guard-design.md`.

## Global Constraints

- Node **24** (`nvm use 24`); pnpm via corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm ...`).
- **Test isolation (mandatory — a prior violation destroyed real data):** every jinn-package test run uses `export JINN_HOME="$(mktemp -d)"` before the command. DB-touching tests use a per-file tmp `JINN_HOME` + dynamic `await import`. **Never** run destructive commands against `~/.jinn`; on unexpected data, STOP and report.
- **TDD**: failing test first, watch it fail, minimal code, watch it pass, commit.
- Verify a package: `corepack pnpm -C packages/<pkg> typecheck && corepack pnpm -C packages/<pkg> test`.
- Do NOT restart `jinn-dev`/`jinn` or touch a live gateway (manual/browser checks are the human's).
- Branch: `feat/bg-agent-resume-guard` (already created).

## File Structure

- `packages/jinn/src/engines/bg-agent-guard.ts` — **new** pure helpers (marker detector + fast-exit tracker + constants).
- `packages/jinn/src/engines/pty-view-engine.ts` — extend `PtyControlEvent`; add optional `clearBgAgentBlock`.
- `packages/jinn/src/engines/pty-stream.ts` — widen `attach` `onData` to pass the chunk; add `pushControl`.
- `packages/jinn/src/engines/claude-interactive.ts` — bg-blocked state + detection in `wireProcToStream` + fast-exit in `onExit` + `ensureIdleSpawn` guard + `clearBgAgentBlock` + onRelease purge.
- `packages/jinn/src/gateway/pty-ws.ts` — handle `{type:"retry"}`.
- `packages/web/src/components/cli-terminal.tsx` — `{type:"bg_agent"}` panel + Fork/Retry + `onForked` prop.
- `packages/web/src/routes/terminals/page.tsx` — pass `onForked`.

---

### Task 1: Pure helpers — refusal detector + fast-exit tracker

**Files:**
- Create: `packages/jinn/src/engines/bg-agent-guard.ts`
- Test: `packages/jinn/src/engines/__tests__/bg-agent-guard.test.ts`

**Interfaces:**
- Produces: `BG_AGENT_MARKER`, `isBgAgentRefusal(text: string): boolean`, `FAST_EXIT_MS`, `FAST_EXIT_LIMIT`, `interface ExitRecord { count: number }`, `registerExit(prev: ExitRecord | undefined, livedMs: number, opts?: { fastMs?: number; limit?: number }): { record: ExitRecord; tripped: boolean }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { isBgAgentRefusal, registerExit } from "../bg-agent-guard.js";

describe("isBgAgentRefusal", () => {
  it("matches Claude's background-agent refusal message", () => {
    expect(isBgAgentRefusal(
      "Session daed9178 is currently running as a background agent (bg). Use `claude agents`…",
    )).toBe(true);
  });
  it("does not match ordinary output", () => {
    expect(isBgAgentRefusal("Resuming session… done.")).toBe(false);
    expect(isBgAgentRefusal("")).toBe(false);
  });
});

describe("registerExit (fast-exit circuit breaker)", () => {
  it("increments on fast exits and trips at the limit", () => {
    let r = registerExit(undefined, 500);       // 1
    expect(r.tripped).toBe(false);
    r = registerExit(r.record, 500);            // 2
    expect(r.tripped).toBe(false);
    r = registerExit(r.record, 500);            // 3 → trip
    expect(r.tripped).toBe(true);
  });
  it("resets the streak when a PTY lives past the window", () => {
    let r = registerExit(undefined, 500);
    r = registerExit(r.record, 500);
    r = registerExit(r.record, 9000);           // survivor → reset
    expect(r.record.count).toBe(0);
    expect(r.tripped).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; export JINN_HOME="$(mktemp -d)"; corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/bg-agent-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/** Claude Code 2.1.x prints this when `--resume` hits a session its agent daemon
 *  holds as a background agent: "Session <id> is currently running as a background
 *  agent (bg). Use `claude agents` … or add --fork-session …". Match a stable
 *  substring so wording/id around it doesn't matter. */
export const BG_AGENT_MARKER = "running as a background agent";

export function isBgAgentRefusal(text: string): boolean {
  return text.includes(BG_AGENT_MARKER);
}

/** Fast-exit circuit breaker: if a session's PTY keeps dying almost immediately,
 *  stop respawning (backstop for any immediate-exit loop, not just bg-agent). */
export const FAST_EXIT_MS = 4000;
export const FAST_EXIT_LIMIT = 3;

export interface ExitRecord {
  count: number;
}

/** Fold one PTY exit into the record. `livedMs` = exit time − spawn time. A PTY that
 *  lived past `fastMs` resets the streak; otherwise the streak grows and trips at
 *  `limit`. Pure — the caller holds one record per session. */
export function registerExit(
  prev: ExitRecord | undefined,
  livedMs: number,
  opts?: { fastMs?: number; limit?: number },
): { record: ExitRecord; tripped: boolean } {
  const fastMs = opts?.fastMs ?? FAST_EXIT_MS;
  const limit = opts?.limit ?? FAST_EXIT_LIMIT;
  if (livedMs >= fastMs) return { record: { count: 0 }, tripped: false };
  const count = (prev?.count ?? 0) + 1;
  return { record: { count }, tripped: count >= limit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/bg-agent-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/jinn/src/engines/bg-agent-guard.ts packages/jinn/src/engines/__tests__/bg-agent-guard.test.ts
git -C /Users/moreira/Development/jinn commit -m "feat(engines): bg-agent refusal detector + fast-exit tracker (pure)"
```

---

### Task 2: Control event `bg_agent` + `pushControl` + widen `attach` onData

**Files:**
- Modify: `packages/jinn/src/engines/pty-view-engine.ts` (`PtyControlEvent`; add optional `clearBgAgentBlock` to the engine interface)
- Modify: `packages/jinn/src/engines/pty-stream.ts` (`attach` signature; add `pushControl`)
- Test: `packages/jinn/src/engines/__tests__/pty-stream-pushcontrol.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type PtyControlEvent = { type: "reset" } | { type: "bg_agent" }`.
  - `PtyStreamManager.pushControl(sessionId: string, event: PtyControlEvent): void`.
  - `attach(sessionId, proc, onData?: (d: string) => void)` (was `onData?: () => void` — widening is backward-compatible; a `() => void` is assignable to `(d: string) => void`).
  - `PtyViewEngine.clearBgAgentBlock?(sessionId: string): void` (optional).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { PtyStreamManager } from "../pty-stream.js";
import type { PtyControlEvent } from "../pty-view-engine.js";

describe("PtyStreamManager.pushControl", () => {
  it("delivers a bg_agent control event to current subscribers", () => {
    const mgr = new PtyStreamManager("TEST", () => false);
    const events: PtyControlEvent[] = [];
    const unsub = mgr.subscribe("s1", () => {}, (e) => events.push(e));
    mgr.pushControl("s1", { type: "bg_agent" });
    expect(events).toContainEqual({ type: "bg_agent" });
    unsub();
  });
  it("is a no-op for an unknown session", () => {
    const mgr = new PtyStreamManager("TEST", () => false);
    expect(() => mgr.pushControl("nope", { type: "bg_agent" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; export JINN_HOME="$(mktemp -d)"; corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/pty-stream-pushcontrol.test.ts`
Expected: FAIL — `pushControl` is not a function / `bg_agent` not assignable to `PtyControlEvent`.

- [ ] **Step 3: Extend the control-event type + engine interface**

In `pty-view-engine.ts`, change:

```typescript
export type PtyControlEvent = { type: "reset" } | { type: "bg_agent" };
```

And add to the `PtyViewEngine` interface (near `writeStdin`/`resizePty`):

```typescript
  /** Clear a session's background-agent block so the next spawn is attempted again
   *  (after the user forks or has cleared the agent in `claude agents`). Optional —
   *  only the claude engine implements it in v1. */
  clearBgAgentBlock?(sessionId: string): void;
```

- [ ] **Step 4: Widen `attach` onData + add `pushControl` in `pty-stream.ts`**

Change the `attach` signature and its data handler to pass the chunk string:

```typescript
  attach(sessionId: string, proc: pty.IPty, onData?: (d: string) => void): void {
```

and inside `proc.onData((d) => { ... })`, change the first line from `onData?.();` to:

```typescript
      onData?.(d);
```

Add the `pushControl` method (after `onPtyExit`):

```typescript
  /** Fan an out-of-band control event to the session's current subscribers (e.g. a
   *  bg_agent notice). No-op if the session has no stream entry. */
  pushControl(sessionId: string, event: PtyControlEvent): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    for (const sub of s.subscribers) {
      try { sub.control?.(event); } catch { /* ignore subscriber errors */ }
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/pty-stream-pushcontrol.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify + commit**

Run: `corepack pnpm -C packages/jinn typecheck` (confirms the `attach` widening + optional interface method compile across all engines).
Expected: clean.

```bash
git -C /Users/moreira/Development/jinn add packages/jinn/src/engines/pty-view-engine.ts packages/jinn/src/engines/pty-stream.ts packages/jinn/src/engines/__tests__/pty-stream-pushcontrol.test.ts
git -C /Users/moreira/Development/jinn commit -m "feat(engines): bg_agent PtyControlEvent + PtyStreamManager.pushControl + chunk-aware attach onData"
```

---

### Task 3: Engine — detect refusal, break the spawn loop, clear

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts`
- Test: `packages/jinn/src/engines/__tests__/claude-interactive-bg-agent.test.ts`

**Interfaces:**
- Consumes: `isBgAgentRefusal`, `registerExit`, `ExitRecord`, `BG_AGENT_MARKER` (Task 1); `pushControl` (Task 2).
- Produces: `InteractiveClaudeEngine.clearBgAgentBlock(sessionId: string): void`; a `{type:"bg_agent"}` control event on detection; `ensureIdleSpawn` no-ops while blocked.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakePty {
  pid: number;
  _dataCb?: (d: string) => void;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void; write: () => void; resize: () => void; on: () => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 7000 + ptys.length,
    onData(cb) { p._dataCb = cb; },
    onExit(cb) { p._exitCb = cb; },
    kill() {}, write() {}, resize() {}, on() {},
  };
  return p;
}
vi.mock("node-pty", () => ({ spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }) }));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class { port = 0; constructor() {} async start() { return 41000; } stop() {} },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import type { PtyControlEvent } from "../pty-view-engine.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 15));
const SID = "test-bg-agent";

describe("InteractiveClaudeEngine — bg-agent resume guard", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;
  beforeEach(() => {
    ptys.length = 0;
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 10, onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id) });
    engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
  });
  afterEach(() => { lifecycle.killAll(); cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID); });

  it("detects the refusal, emits bg_agent, blocks respawn, and clear re-enables it", async () => {
    const events: PtyControlEvent[] = [];
    const unsub = engine.subscribeOutput(SID, () => {}, (e) => events.push(e));

    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();
    expect(ptys).toHaveLength(1);

    // claude prints the refusal, then the PTY exits (as it does on refusal).
    ptys[0]._dataCb!("Session e1 is currently running as a background agent (bg). Use `claude agents`…");
    expect(events).toContainEqual({ type: "bg_agent" });
    ptys[0]._exitCb!({ exitCode: 1 });
    await flush();

    // Blocked: a new viewer event does NOT respawn.
    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();
    expect(ptys).toHaveLength(1);

    // Clearing the block re-enables spawning.
    engine.clearBgAgentBlock(SID);
    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();
    expect(ptys).toHaveLength(2);
    unsub();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; export JINN_HOME="$(mktemp -d)"; corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/claude-interactive-bg-agent.test.ts`
Expected: FAIL — `clearBgAgentBlock` missing / `bg_agent` never emitted / respawn still happens.

- [ ] **Step 3: Add imports + state fields**

At the top of `claude-interactive.ts`, add the import:

```typescript
import { isBgAgentRefusal, registerExit, BG_AGENT_MARKER, type ExitRecord } from "./bg-agent-guard.js";
```

Add these private fields to the `InteractiveClaudeEngine` class (near the other per-session maps like `lastOutputAt`):

```typescript
  /** Sessions whose --resume was refused because Claude holds the session as a
   *  background agent (or that fast-exit-looped). ensureIdleSpawn skips these until
   *  clearBgAgentBlock. */
  private bgAgentBlocked = new Set<string>();
  /** Rolling tail of recent PTY output per session, so the refusal marker is caught
   *  even when it spans two data chunks. */
  private bgScanCarry = new Map<string, string>();
  /** Spawn timestamp + consecutive fast-exit count per session (fast-exit backstop). */
  private spawnAtMs = new Map<string, number>();
  private exitRecords = new Map<string, ExitRecord>();
```

- [ ] **Step 4: Wire detection into `wireProcToStream` (output scan + fast-exit)**

In `wireProcToStream`, record the spawn time and pass a scanning `onData` to `streams.attach`. Replace:

```typescript
    this.streams.attach(jinnSessionId, proc, () => this.lastOutputAt.set(jinnSessionId, Date.now()));
```

with:

```typescript
    this.spawnAtMs.set(jinnSessionId, Date.now());
    this.streams.attach(jinnSessionId, proc, (d) => {
      this.lastOutputAt.set(jinnSessionId, Date.now());
      this.scanForBgAgent(jinnSessionId, d);
    });
```

Inside the `proc.onExit(() => { ... })` handler, add the fast-exit backstop as the FIRST statements in the callback (before the `isCurrent` block):

```typescript
      const spawnMs = this.spawnAtMs.get(jinnSessionId);
      if (spawnMs !== undefined) {
        const { record, tripped } = registerExit(this.exitRecords.get(jinnSessionId), Date.now() - spawnMs);
        this.exitRecords.set(jinnSessionId, record);
        if (tripped && !this.bgAgentBlocked.has(jinnSessionId)) {
          this.bgAgentBlocked.add(jinnSessionId);
          this.streams.pushControl(jinnSessionId, { type: "bg_agent" });
          logger.warn(`InteractiveClaudeEngine: session ${jinnSessionId} PTY fast-exited ${record.count}× — blocking respawn`);
        }
      }
```

- [ ] **Step 5: Add the scanner, the `ensureIdleSpawn` guard, `clearBgAgentBlock`, and onRelease purge**

Add the scanner method (near `wireProcToStream`):

```typescript
  /** Watch PTY output for Claude's background-agent resume refusal. On match, block
   *  further respawns and notify the viewer. Keeps a short carry so a marker split
   *  across chunks is still caught. */
  private scanForBgAgent(jinnSessionId: string, d: string): void {
    if (this.bgAgentBlocked.has(jinnSessionId)) return;
    const combined = (this.bgScanCarry.get(jinnSessionId) ?? "") + d;
    if (isBgAgentRefusal(combined)) {
      this.bgAgentBlocked.add(jinnSessionId);
      this.bgScanCarry.delete(jinnSessionId);
      this.streams.pushControl(jinnSessionId, { type: "bg_agent" });
      logger.info(`InteractiveClaudeEngine: bg-agent resume refusal for session ${jinnSessionId} — blocking respawn`);
      return;
    }
    // Retain only enough tail to bridge a chunk boundary.
    this.bgScanCarry.set(jinnSessionId, combined.slice(-BG_AGENT_MARKER.length));
  }

  /** Clear a session's bg-agent block (Retry / after fork). Next spawn is attempted. */
  clearBgAgentBlock(jinnSessionId: string): void {
    this.bgAgentBlocked.delete(jinnSessionId);
    this.exitRecords.delete(jinnSessionId);
    this.bgScanCarry.delete(jinnSessionId);
    this.spawnAtMs.delete(jinnSessionId);
  }
```

In `ensureIdleSpawn`, add the guard alongside the existing early-returns (after `if (this.idleSpawning.has(jinnSessionId)) return;`):

```typescript
    if (this.bgAgentBlocked.has(jinnSessionId)) return; // resume refused — await Fork/Retry
```

In the `this.lifecycle.onRelease((id) => { ... })` handler (where `lastOutputAt`/`spawnParams` are purged), add:

```typescript
      this.bgScanCarry.delete(id);
      this.spawnAtMs.delete(id);
      // NOTE: do NOT clear bgAgentBlocked/exitRecords here — the block must survive the
      // failed PTY's release (that's what stops the respawn loop); clearBgAgentBlock owns it.
```

- [ ] **Step 6: Run test to verify it passes**

Run: `corepack pnpm -C packages/jinn exec vitest run src/engines/__tests__/claude-interactive-bg-agent.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify full backend + commit**

Run: `export JINN_HOME="$(mktemp -d)"; corepack pnpm -C packages/jinn typecheck && corepack pnpm -C packages/jinn test`
Expected: typecheck clean; full suite green.

```bash
git -C /Users/moreira/Development/jinn add packages/jinn/src/engines/claude-interactive.ts packages/jinn/src/engines/__tests__/claude-interactive-bg-agent.test.ts
git -C /Users/moreira/Development/jinn commit -m "feat(claude-interactive): detect bg-agent refusal, break respawn loop, clearBgAgentBlock"
```

---

### Task 4: pty-ws `{type:"retry"}` handler

**Files:**
- Modify: `packages/jinn/src/gateway/pty-ws.ts`

**Interfaces:**
- Consumes: `engine.clearBgAgentBlock?` (Task 2 interface), `spawnIfNeeded` (existing in pty-ws).
- Produces: a client→server `{type:"retry"}` message that clears the block and re-spawns at the last geometry.

- [ ] **Step 1: Track last geometry + handle retry**

In `attachPtyWebSocket`, add mutable geometry tracking near the other `let` declarations (e.g. after `let pendingViewing`):

```typescript
  let lastCols = 0;
  let lastRows = 0;
```

In the `{type:"resize"}` branch, record the geometry (add at the top of that branch, before `spawnIfNeeded`):

```typescript
      lastCols = msg.cols;
      lastRows = msg.rows;
```

Add a new branch to the `ws.on("message", ...)` handler (after the `viewing` branch):

```typescript
    } else if (msg?.type === "retry") {
      // The client's bg-agent panel asked to retry — clear the block and respawn at
      // the last known geometry (falls back to the engine's cached geometry if we
      // never saw a resize).
      engine.clearBgAgentBlock?.(sessionId);
      if (lastCols > 0 && lastRows > 0) spawnIfNeeded(lastCols, lastRows);
```

- [ ] **Step 2: Verify (typecheck; pty-ws message routing isn't unit-tested in this codebase — the clear logic is covered by Task 3)**

Run: `corepack pnpm -C packages/jinn typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/jinn/src/gateway/pty-ws.ts
git -C /Users/moreira/Development/jinn commit -m "feat(pty-ws): handle {type:retry} — clear bg-agent block + respawn"
```

---

### Task 5: xterm client — bg_agent panel + Fork/Retry + `onForked`

**Files:**
- Modify: `packages/web/src/components/cli-terminal.tsx`
- Modify: `packages/web/src/routes/terminals/page.tsx`

**Interfaces:**
- Consumes: `{type:"bg_agent"}` control frame (already forwarded by pty-ws); `useDuplicateSession` (`packages/web/src/hooks/use-sessions.ts` — `mutateAsync(id)` returns the API response; confirm the new-session id field via `api.duplicateSession` in `packages/web/src/lib/api.ts` and use it).
- Produces: `CliTerminal` prop `onForked?: (newSessionId: string) => void`.

- [ ] **Step 1: Add state + the control-frame handler**

In `cli-terminal.tsx`:
- Add `onForked?: (newSessionId: string) => void` to the component's props type and destructure it.
- Add `const [bgAgent, setBgAgent] = useState(false)` next to the other `useState` hooks.
- Import the hook: `import { useDuplicateSession } from "@/hooks/use-sessions"`, and inside the component: `const duplicate = useDuplicateSession()`.
- In `onWsMessage`, where `msg?.type === "reset"` is handled, add a sibling branch:

```typescript
          if (msg?.type === "bg_agent") {
            setBgAgent(true);
            return;
          }
```
- When a normal (non-control) data frame arrives (in the same handler, after the JSON checks, in the branch that writes to the terminal), clear the panel if it was up: add `if (bgAgentRef.current) setBgAgentSafely(false)` — to avoid a stale closure, mirror the existing `hasOutputRef` pattern: add `const bgAgentRef = useRef(false)` and a `setBgAgentSafely = (v) => { bgAgentRef.current = v; setBgAgent(v) }`, use `setBgAgentSafely` everywhere you set `bgAgent`, and clear it on the first data frame after a retry.

- [ ] **Step 2: Render the panel**

In the returned JSX (as a sibling of the `reconnecting`/`!hasOutput` overlays), add:

```tsx
      {bgAgent && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: "0.75rem", padding: "1.5rem",
          background: "var(--bg)", textAlign: "center" }}>
          <div style={{ color: "var(--text-secondary)", fontFamily: "var(--font-code)", fontSize: 13, maxWidth: 420 }}>
            This session is running as a <strong>background agent</strong> in Claude Code, so it
            can’t be resumed here directly.
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              disabled={duplicate.isPending}
              onClick={async () => {
                const res = await duplicate.mutateAsync(sessionId);
                setBgAgentSafely(false);
                const newId = (res as any)?.session?.id ?? (res as any)?.id;
                if (newId) onForked?.(newId);
              }}
              style={{ padding: "0.35rem 0.9rem", borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13 }}
            >
              {duplicate.isPending ? "Forking…" : "Fork a copy"}
            </button>
            <button
              onClick={() => {
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "retry" }));
                setBgAgentSafely(false);
              }}
              style={{ padding: "0.35rem 0.9rem", borderRadius: 6, background: "var(--fill-secondary)", color: "var(--text-primary)", fontSize: 13 }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
```

> Confirm the `api.duplicateSession` return shape in `packages/web/src/lib/api.ts` and adjust the `newId` extraction (`res.session?.id` vs `res.id`) to match; keep the `?? ` fallback so either shape works.

- [ ] **Step 3: Pass `onForked` from the Terminals page**

In `packages/web/src/routes/terminals/page.tsx`, change the focused terminal render:

```tsx
            <CliTerminal key={selectedId} sessionId={selectedId} interactive onForked={setSelectedId} />
```

- [ ] **Step 4: Verify (typecheck + build; the bg_agent/pushControl logic is covered by Tasks 2–3)**

Run: `corepack pnpm -C packages/web typecheck && corepack pnpm -C packages/web build`
Expected: both clean.

- [ ] **Step 5: Manual check (human — deferred)**

Reproduce a bg-agent session, open it in Terminals: instead of a spinning/blank terminal you see the panel; **Retry** re-attempts, **Fork a copy** opens a working duplicate.

- [ ] **Step 6: Commit**

```bash
git -C /Users/moreira/Development/jinn add packages/web/src/components/cli-terminal.tsx packages/web/src/routes/terminals/page.tsx
git -C /Users/moreira/Development/jinn commit -m "feat(web): bg-agent panel with Fork/Retry in the terminal view"
```

---

## Self-review notes

- **Spec coverage:** §3.1 detect → Tasks 1 (pure) + 3 (wire); §3.2 break-loop → Task 3 (`ensureIdleSpawn` guard); §3.3 surface → Task 2 (event + pushControl) + Task 5 (panel); §3.4 actions → Task 4 (retry) + Task 5 (Fork/Retry buttons, reuse duplicate endpoint). Fast-exit backstop → Task 1 (pure) + Task 3 (onExit wiring).
- **Type consistency:** `PtyControlEvent` `{type:"bg_agent"}` used identically in pty-view-engine, pty-stream, claude-interactive, pty-ws (forwarded), and cli-terminal; `clearBgAgentBlock` optional on the interface, concrete on claude, called via `?.` from pty-ws; `registerExit`/`ExitRecord`/`isBgAgentRefusal` signatures match producer (Task 1) and consumer (Task 3).
- **No placeholders:** every code step is complete; UI/pty-ws steps verify via typecheck/build because this codebase unit-tests the extracted pure/stream logic, not JSX or WS routing. Task 5 flags the one runtime detail to confirm (duplicate response shape) with a safe fallback.
