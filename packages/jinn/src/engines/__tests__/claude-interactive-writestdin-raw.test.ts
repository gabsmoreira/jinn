import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression: the interactive Terminals view forwards every keystroke to the PTY
// as {type:"stdin"} (xterm's onData fires per character). That routed to
// writeStdin(), which called pasteAndSubmit() — bracketed-paste + an auto-CR 150ms
// later. So EACH keystroke was submitted as its own command ("sends commands
// before I finish typing"). writeStdin must be a RAW passthrough; only the user's
// own Enter (\r, sent through the same path) submits. pasteAndSubmit stays for the
// whole-prompt injection path (injectPrompt), which is unaffected.

const writes: string[] = [];
interface FakePty {
  pid: number;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void;
  write: (d: string) => void;
  resize: () => void;
  on: () => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 4000 + ptys.length,
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() {},
    write(d: string) { writes.push(d); },
    resize() {},
    on() {},
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => { const p = makeFakePty(); ptys.push(p); return p; }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41000; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 15));
const SID = "test-writestdin-raw";

describe("InteractiveClaudeEngine.writeStdin — raw passthrough for interactive typing", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    writes.length = 0;
    lifecycle = new PtyLifecycleManager({
      maxLivePtys: 10,
      onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id),
    });
    engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  it("forwards keystrokes verbatim — no bracketed-paste wrapper, no auto-submit", async () => {
    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();
    writes.length = 0; // ignore any spawn-time writes; measure only writeStdin

    engine.writeStdin(SID, "hello");

    // Raw passthrough: exactly the bytes typed. The bracketed-paste opener
    // (\x1b[200~) IS the auto-submit mechanism (pasteAndSubmit follows it with a
    // CR), so its absence proves keystrokes are no longer submitted one-by-one.
    expect(writes.join("")).toBe("hello");
    expect(writes.join("")).not.toContain("\x1b[200~");
  });

  it("passes a real Enter (\\r) through so the user can submit", async () => {
    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();
    writes.length = 0;

    engine.writeStdin(SID, "\r");

    expect(writes.join("")).toBe("\r");
    expect(writes.join("")).not.toContain("\x1b[200~");
  });
});
