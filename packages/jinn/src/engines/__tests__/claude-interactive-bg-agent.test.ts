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
