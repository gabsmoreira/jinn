import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

// Regression: ensureIdleSpawn (the CLI/xterm viewer spawn) used to write the
// per-session --settings file BEFORE `await startProxy(...)`, then spawn
// `claude --settings <file>` after the bind resolved. A PTY release for the same
// session during that async gap (e.g. a just-failed `--resume` claude exiting)
// fires onCleanup → cleanupSessionSettings(), which DELETES that exact file — so
// claude started against a settings path that no longer existed and the terminal
// showed "Settings file not found". The fix writes the file right before spawn,
// after the bind (mirroring the run() cold-respawn path). This test drives the
// REAL write/cleanup helpers and simulates the release firing during the bind.

// Records, per pty.spawn() call, whether the --settings file existed at that instant.
const settingsExistedAtSpawn: boolean[] = [];

interface FakePty {
  pid: number;
  _exitCode: number | null;
  _exitCb?: (e: { exitCode: number }) => void;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  kill: () => void;
  write: () => void;
  resize: () => void;
  on: () => void;
}
const ptys: FakePty[] = [];
function makeFakePty(): FakePty {
  const p: FakePty = {
    pid: 3000 + ptys.length,
    _exitCode: null,
    onData() {},
    onExit(cb) { p._exitCb = cb; },
    kill() {},
    write() {},
    resize() {},
    on() {},
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    const i = args.indexOf("--settings");
    const settingsPath = i >= 0 ? args[i + 1] : "";
    settingsExistedAtSpawn.push(settingsPath ? fs.existsSync(settingsPath) : false);
    const p = makeFakePty();
    ptys.push(p);
    return p;
  }),
}));

// Fires while the engine is `await`ing the proxy bind — the exact window the bug
// lived in. Lets a test inject a concurrent release mid-gap.
let onProxyStart: (() => void) | undefined;
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { onProxyStart?.(); return 41000; }
    stop() {}
  },
}));
// IMPORTANT: do NOT mock ../shared/claude-settings.js — the bug lived in the real
// write→delete ordering, so the test must exercise the real helpers.

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { cleanupSessionSettings, sessionSettingsPath } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";

const flush = () => new Promise((r) => setTimeout(r, 15));
const SID = "test-idle-settings-race";

describe("InteractiveClaudeEngine — ensureIdleSpawn settings file survives a release during the proxy bind", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: InteractiveClaudeEngine;

  beforeEach(() => {
    ptys.length = 0;
    settingsExistedAtSpawn.length = 0;
    onProxyStart = undefined;
    // Mirror the gateway wiring: onCleanup deletes the per-session --settings file.
    lifecycle = new PtyLifecycleManager({
      maxLivePtys: 10,
      onCleanup: (id) => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id),
    });
    const hookRegistry = {
      register: () => {},
      unregister: () => {},
    } as any;
    engine = new InteractiveClaudeEngine(lifecycle, hookRegistry);
  });

  afterEach(() => {
    lifecycle.killAll();
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);
  });

  it("idle spawn spawns against an EXISTING settings file even if a release fires during the bind", async () => {
    // Simulate a concurrent PTY release (which deletes the per-session --settings
    // file) firing during the async proxy bind — exactly the window the bug lived in.
    onProxyStart = () => cleanupSessionSettings(CLAUDE_SETTINGS_DIR, SID);

    engine.ensureIdleSpawn(SID, { engineSessionId: "e1", cols: 80, rows: 24 } as any);
    await flush();

    expect(settingsExistedAtSpawn.length).toBe(1);  // the idle PTY was spawned
    expect(settingsExistedAtSpawn[0]).toBe(true);   // ← regression guard
    // And the file is really on disk for the live PTY.
    expect(fs.existsSync(sessionSettingsPath(CLAUDE_SETTINGS_DIR, SID))).toBe(true);
  });
});
