import { afterEach, describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at the top level. node-pty loads its
// native module at import time and that fails on Linux CI runners (looks for
// prebuilds/linux-x64/pty.node under a wrong relative path). TurnResolver is a
// pure-JS class with zero PTY dependency, so mocking the module keeps the test
// focused and CI-portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import { TurnResolver, buildInteractiveArgs, claudeHookToDeltas, sseEventToDeltas, pasteAndSubmit, disallowedTools, InteractiveClaudeEngine } from "../claude-interactive.js";
import { MAIN_AGENT_SENTINEL } from "../sse-pty-proxy.js";
import { buildPromptWithPlatformContext } from "../platform-context.js";
import { AskUserQuestionAssembler } from "../ask-user-question.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("claudeHookToDeltas", () => {
  it("does not emit a duplicate tool_use for PreToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf ok" },
    })).toEqual([]);
  });

  it("emits a tool_result for PostToolUse", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
    })).toEqual([{ type: "tool_result", content: "Bash", toolName: "Bash" }]);
  });

  it("suppresses the raw tool_result marker for AskUserQuestion (clean question block owns the UI)", () => {
    expect(claudeHookToDeltas({
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
    })).toEqual([]);
  });
});

describe("sseEventToDeltas — AskUserQuestion tool_use suppression", () => {
  it("suppresses the tool_use marker for AskUserQuestion (clean question block owns the UI)", () => {
    const deltas = sseEventToDeltas({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "AskUserQuestion", id: "toolu_x" },
    } as any);
    expect(deltas).toEqual([]);
  });

  it("control: still emits a tool_use marker for other tools (e.g. Bash)", () => {
    const deltas = sseEventToDeltas({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", name: "Bash", id: "toolu_x" },
    } as any);
    expect(deltas).toEqual([{ type: "tool_use", content: "Bash", toolName: "Bash", toolId: "toolu_x" }]);
  });
});

describe("TurnResolver", () => {
  it("resolves only after BOTH SessionStart and Stop", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved).toBeUndefined(); // Stop alone is not enough
    r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved.result).toBe("done");
    expect(resolved.sessionId).toBe("claude-123");
    expect(resolved.numTurns).toBe(1);
  });

  it("settles with an Interrupted error when killed", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.interrupt("Interrupted: user");
    const v = await r.promise;
    expect(v.error).toMatch(/^Interrupted/);
  });

  it("treats a missing session id as a hard error", async () => {
    const r = new TurnResolver({ fallbackSessionId: undefined });
    r.onHook({ hook_event_name: "SessionStart" }); // no session_id
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
    const v = await r.promise;
    expect(v.error).toMatch(/session id/i);
  });

  it("with assumeStarted, resolves on Stop alone using fallbackSessionId", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "ok" });
    const v = await r.promise;
    expect(v.result).toBe("ok");
    expect(v.sessionId).toBe("warm-sid");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from Stop hook assistant text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({
      hook_event_name: "Stop",
      last_assistant_message: "<thinking>private reasoning</thinking>\n\nVisible answer.",
    });
    const v = await r.promise;
    expect(v.result).toBe("Visible answer.");
    expect(v.result).not.toContain("private reasoning");
    expect(v.sessionId).toBe("warm-sid");
  });

  it("settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    const v = await r.promise;
    expect(v.error).toMatch(/rate_limit/);
    expect(v.numTurns).toBe(1);
    expect(r.stopFailure?.error).toBe("rate_limit");
  });

  it("can recover-complete a turn when the Stop hook is missing", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("transcript final", "c1");
    const v = await r.promise;
    expect(v.result).toBe("transcript final");
    expect(v.sessionId).toBe("c1");
    expect(v.numTurns).toBe(1);
  });

  it("strips leaked thinking blocks from recovered transcript text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("<thinking>private transcript reasoning</thinking>\n\nVisible transcript answer.", "c1");
    const v = await r.promise;
    expect(v.result).toBe("Visible transcript answer.");
    expect(v.result).not.toContain("private transcript reasoning");
  });
});

describe("buildInteractiveArgs — system prompt + sentinel via CLI flag", () => {
  // Regression guard: the claude CLI ignores the settings-file `appendSystemPrompt`
  // KEY (≥2.1.x), so the persona + MAIN_AGENT_SENTINEL MUST go via the
  // --append-system-prompt FLAG, or the SSE proxy never tees and live streaming dies.
  const flagValue = (args: string[]): string | undefined => {
    const i = args.indexOf("--append-system-prompt");
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("emits --append-system-prompt carrying the persona AND the sentinel", () => {
    const args = buildInteractiveArgs({
      prompt: "hi",
      settingsPath: "/tmp/s.json",
      appendSystemPrompt: `You are Jinn's COO.\n\n${MAIN_AGENT_SENTINEL}`,
    });
    const v = flagValue(args);
    expect(v).toBeDefined();
    expect(v).toContain("You are Jinn's COO.");
    expect(v).toContain(MAIN_AGENT_SENTINEL);
  });

  it("omits the flag when no appendSystemPrompt is given", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/tmp/s.json" });
    expect(args).not.toContain("--append-system-prompt");
  });

  it("can carry a current platform context refresh in the positional resume prompt", () => {
    const prompt = buildPromptWithPlatformContext({
      prompt: "spawn the child now",
      resumeSessionId: "original-claude-id",
      systemPrompt: [
        "# You are Jimbo",
        "## Current session",
        "- Session ID: duplicated-jinn-session",
        "## Current configuration",
        "- Gateway: http://127.0.0.1:7777",
        "## Organization",
        "- Should not be repeated on resume",
      ].join("\n"),
    });
    const args = buildInteractiveArgs({ prompt, settingsPath: "/tmp/s.json", resumeSessionId: "original-claude-id" });
    const positionalPrompt = args[args.indexOf("original-claude-id") + 1];
    expect(positionalPrompt).toContain("## Jinn platform context refresh");
    expect(positionalPrompt).toContain("- Session ID: duplicated-jinn-session");
    expect(positionalPrompt).not.toContain("Should not be repeated on resume");
    expect(positionalPrompt).toContain("spawn the child now");
  });
});

describe("pasteAndSubmit", () => {
  it("waits for multiline bracketed paste to settle before submitting", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const proc = { write: (data: string) => { writes.push(data); } };

    pasteAndSubmit(proc as any, "Describe this image\n\nAttached files:\n- /tmp/image.png");

    expect(writes).toEqual(["\x1b[200~Describe this image\n\nAttached files:\n- /tmp/image.png\x1b[201~"]);
    vi.advanceTimersByTime(149);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([
      "\x1b[200~Describe this image\n\nAttached files:\n- /tmp/image.png\x1b[201~",
      "\r",
    ]);
  });
});

describe("disallowedTools helper", () => {
  it("blocks only ExitPlanMode when AskUserQuestion is allowed", () => {
    const tools = disallowedTools(true);
    expect(tools).toContain("ExitPlanMode");
    expect(tools).not.toContain("AskUserQuestion");
  });

  it("also blocks AskUserQuestion when disallowed", () => {
    const tools = disallowedTools(false);
    expect(tools).toContain("ExitPlanMode");
    expect(tools).toContain("AskUserQuestion");
  });
});

describe("buildInteractiveArgs — disallowed tools", () => {
  it("defaults to allowing AskUserQuestion (only ExitPlanMode blocked)", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/s.json" });
    const i = args.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    const after = args.slice(i + 1);
    expect(after).toContain("ExitPlanMode");
    // AskUserQuestion must not appear before the next flag token.
    const nextFlag = after.findIndex((a) => a.startsWith("--"));
    const disallowed = nextFlag === -1 ? after : after.slice(0, nextFlag);
    expect(disallowed).not.toContain("AskUserQuestion");
  });

  it("blocks AskUserQuestion when allowAskUserQuestion is false", () => {
    const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/s.json", allowAskUserQuestion: false });
    const i = args.indexOf("--disallowedTools");
    const after = args.slice(i + 1);
    const nextFlag = after.findIndex((a) => a.startsWith("--"));
    const disallowed = nextFlag === -1 ? after : after.slice(0, nextFlag);
    expect(disallowed).toContain("ExitPlanMode");
    expect(disallowed).toContain("AskUserQuestion");
  });
});

function engineWithFakePty(writes: string[]) {
  const proc = { write: (d: string) => { writes.push(d); } };
  const handle = { _proc: proc };
  const lifecycle: any = {
    getWarm: () => handle,
    onRelease: () => {},
  };
  const hookRegistry: any = { register: () => {}, unregister: () => {} };
  return new InteractiveClaudeEngine(lifecycle, hookRegistry);
}

describe("InteractiveClaudeEngine.answerQuestion", () => {
  it("writes Down×index then Enter for a single-select pick", () => {
    const writes: string[] = [];
    const engine = engineWithFakePty(writes);
    const ok = engine.answerQuestion("jinn-1", [2]);
    expect(ok).toBe(true);
    expect(writes).toEqual(["\x1b[B", "\x1b[B", "\r"]);
  });

  it("picks the first option with just Enter (index 0)", () => {
    const writes: string[] = [];
    const engine = engineWithFakePty(writes);
    engine.answerQuestion("jinn-1", [0]);
    expect(writes).toEqual(["\r"]);
  });

  it("returns false when there is no warm PTY", () => {
    const lifecycle: any = { getWarm: () => undefined, onRelease: () => {} };
    const engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
    expect(engine.answerQuestion("jinn-1", [1])).toBe(false);
  });
});

describe("InteractiveClaudeEngine — AskUserQuestion question-block emission (handleSseEvent)", () => {
  // handleSseEvent is private and only reachable in production via the per-PTY
  // SSE proxy callback wired inside spawn()/ensureIdleSpawn(). There is no public
  // seam to install an "active turn" without a real PTY spawn, so this test
  // reaches into the private `active` map directly (same style as reading
  // internals elsewhere in this file) to set up the state handleSseEvent expects,
  // then invokes the private method via an `any` cast.
  it("emits ONLY a clean question block — no raw tool_use marker — for a single-question AskUserQuestion tool_use", () => {
    const writes: string[] = [];
    const engine = engineWithFakePty(writes);
    const sessionId = "jinn-askq-emission";
    const deltas: any[] = [];
    const resolver = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });

    (engine as any).active.set(sessionId, {
      resolver,
      onStream: (d: any) => deltas.push(d),
      askq: new AskUserQuestionAssembler(),
    });

    const emit = (e: any) => (engine as any).handleSseEvent(sessionId, e);

    emit({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_e", name: "AskUserQuestion" },
    });
    emit({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          questions: [{
            header: "Pick one",
            question: "Which approach?",
            multiSelect: false,
            options: [{ label: "A" }, { label: "B" }],
          }],
        }),
      },
    });
    emit({ type: "content_block_stop", index: 0 });

    // No raw tool_use marker leaked through for AskUserQuestion.
    expect(deltas.some((d) => d.type === "tool_use")).toBe(false);

    const blockDeltas = deltas.filter((d) => d.type === "block");
    expect(blockDeltas).toHaveLength(1);
    const block = blockDeltas[0].block;
    expect(block.op).toBe("put");
    expect(block.block.type).toBe("question");
    expect(block.block.id).toBe("askq-toolu_e");
    expect(block.block.payload.questions[0].question).toBe("Which approach?");
    expect(block.block.payload.questions[0].options).toEqual([{ label: "A" }, { label: "B" }]);
  });
});
