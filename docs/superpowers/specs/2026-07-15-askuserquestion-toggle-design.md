# AskUserQuestion Settings Toggle — Design

**Date:** 2026-07-15
**Status:** Approved (pending user review)
**Follows:** [2026-07-14-askuserquestion-chat-choices-design.md](./2026-07-14-askuserquestion-chat-choices-design.md)

## Problem

The interactive AskUserQuestion feature (Claude presents multiple-choice questions
as clickable options in the web chat) is always on. Operators need a way to turn it
off — for example, when they prefer plain-text questions or want to avoid the native
TUI selector entirely.

## Goal

Add a single configurable toggle that enables/disables the AskUserQuestion tool. When
off, Claude never uses the interactive selector and instead asks questions as plain
text.

## Decisions

- **Off behavior:** Block the tool entirely. When disabled, `AskUserQuestion` is added
  to the CLI's `--disallowedTools`, so Claude never invokes the interactive selector
  and the question-block rendering path never fires (it falls back to plain-text
  questions).
- **Where it lives:** Gateway config (`config.yaml`), not browser `localStorage`. The
  tool allow-list is decided server-side at CLI spawn time, so a client-side setting
  could not gate it.
- **Default:** On (opt-out). Preserves current behavior for existing users and fresh
  installs.
- **Config home:** Under `sessions`, grouped with `interruptOnNewMessage`. It is a
  session-UX behavior and sits naturally beside the existing session toggle in both
  the config type and the settings UI.

## Out of scope (separate follow-up)

Surfacing AskUserQuestion prompts raised by **subagents** to the main agent/user, and
dispatching the selection back to the subagent, is deliberately excluded here. That
work depends on how the real `claude` CLI behaves for subagent questions and requires
a spike first. It will be its own spec. See "Follow-up" below.

## Design

### 1. Config schema — `packages/jinn/src/shared/types.ts`

Add one optional field to the existing `sessions` block:

```ts
sessions?: {
  maxDurationMinutes?: number;
  maxCostUsd?: number;
  interruptOnNewMessage?: boolean;
  /** Allow Claude's interactive AskUserQuestion tool (clickable chat options). Default: true. */
  interactiveQuestions?: boolean;
  rateLimitStrategy?: "wait" | "fallback";
  fallbackEngine?: "codex";
};
```

No config normalization change is required — the field is read with a `?? true`
default at the point of use.

### 2. Engine gating — `packages/jinn/src/engines/claude-interactive.ts`

Replace the frozen `DISALLOWED_TOOLS` const with a helper:

```ts
/** Tools the interactive PTY blocks. ExitPlanMode is always blocked. AskUserQuestion
 *  is blocked only when interactive questions are disabled in config. Single source
 *  of truth for both spawn paths (buildInteractiveArgs and ensureIdleSpawn). */
export function disallowedTools(allowAskUserQuestion: boolean): string[] {
  const tools = ["ExitPlanMode"];
  if (!allowAskUserQuestion) tools.push("AskUserQuestion");
  return tools;
}
```

Both spawn paths resolve the flag from config at spawn time and pass the resulting
list to `--disallowedTools`:

- `buildInteractiveArgs` gains `allowAskUserQuestion?: boolean` on its opts (default
  `true`), keeping it a pure function. Its `spawn()` caller reads
  `loadConfig().sessions?.interactiveQuestions ?? true` and passes it in.
- `ensureIdleSpawn` reads the same value and builds its args array from
  `disallowedTools(...)`.

Reading config inside these two impure spawn methods (which already perform process
I/O) localizes the change — no new plumbing through `EngineRunOpts` or the `pty-ws`
call site. The value is a global knob, not per-session, so a per-spawn read is
correct and cheap.

### 3. Settings UI — `packages/web/src/routes/settings/page.tsx`

Add a `ToggleSwitch` row to the existing **Sessions** section, reusing the
`FieldRow` + description pattern already used by `interruptOnNewMessage`:

- Label: **Interactive Questions**
- Bound to `config.sessions?.interactiveQuestions ?? true`
- `onChange` → `updateConfig(["sessions", "interactiveQuestions"], v)`
- Description: "When enabled, Claude can present multiple-choice questions as
  clickable options in chat. When disabled, it asks in plain text."

No new API surface — it rides the existing config GET / PATCH (`Save Config`) flow.

## Data flow

1. Operator toggles **Interactive Questions** in Settings → Sessions.
2. `Save Config` PATCHes `config.yaml` (`sessions.interactiveQuestions`).
3. Next PTY spawn (`spawn()` or `ensureIdleSpawn()`) reads the value and computes
   `--disallowedTools`.
4. On: `["ExitPlanMode"]` — AskUserQuestion works as today.
   Off: `["ExitPlanMode", "AskUserQuestion"]` — Claude cannot call the tool and asks
   in plain text; the assembler/question-block path never fires.

Note: the setting takes effect on the next PTY spawn. A warm PTY started before the
change keeps its spawn-time tool list until it is recycled/respawned.

## Error handling

- Missing/malformed `sessions.interactiveQuestions` → treated as `true` via `?? true`.
- No change to failure modes of the spawn paths; `disallowedTools()` is total.

## Testing

- Unit: `disallowedTools(true)` returns `["ExitPlanMode"]`; `disallowedTools(false)`
  additionally includes `"AskUserQuestion"`.
- Unit: `buildInteractiveArgs({ allowAskUserQuestion: false, ... })` emits
  `AskUserQuestion` in the `--disallowedTools` args; `true`/default omits it.
- (If a cheap harness exists) config round-trip: setting persists through PATCH/GET.

## Follow-up (separate spec, after a spike)

**Subagent AskUserQuestion surfacing.** Today the SSE proxy tees only main-agent
streams (gated on `MAIN_AGENT_SENTINEL` in `sse-pty-proxy.ts:shouldTeeToUi`), so a
subagent's AskUserQuestion never renders clickable options — though the PTY blocks on
the selector. The answer-dispatch side already works (`answerQuestion` drives the
shared session PTY, agent-agnostic).

Spike questions to answer against the real CLI before designing the fix:
1. Does the `claude` CLI allow a Task subagent to call AskUserQuestion at all?
2. If so, does it render the TUI selector in the parent PTY (required for keystroke
   driving)?
3. Under which request does the tool_use SSE arrive (confirming a no-sentinel stream)?

Likely fix (gated on findings): a narrow proxy exception that tees *only*
AskUserQuestion tool_use blocks from non-sentinel streams, keeping all other subagent
output suppressed; the existing emission + answer-dispatch then closes the loop. v1
would handle one question at a time (concurrent subagents contend for the single
shared PTY selector).
