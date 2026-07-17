# AskUserQuestion → selectable chat choices

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan
**Scope:** Interactive Claude engine (`InteractiveClaudeEngine`) + web chat view

## Problem

The interactive Claude engine launches `claude` with
`--disallowedTools AskUserQuestion ExitPlanMode`, so Claude cannot ask the user
multiple-choice clarifying questions. We want to re-enable `AskUserQuestion` and
surface its choices as clickable options in the **chat** view, routing the
user's pick back to the live session so the turn continues naturally.

`ExitPlanMode` stays disabled — out of scope.

## Confirmed behaviour (verified against Claude Code 2.1.209)

Triggering a real `AskUserQuestion` in a PTY established:

- It renders a **native TUI selector**: a header (e.g. `Color`), the question
  text (`Pick a color`), each option with its description, plus two
  auto-injected rows — `Type something.` (free-text) and `Chat about this`.
- Navigation is **`↑`/`↓` + `Enter`** only. Cursor starts on option 0. Digit
  keys do **not** jump selection.
- The **PreToolUse hook does NOT fire** for this tool, so structured
  question/option data must come from the **SSE stream** (the tool_use block's
  `input_json_delta` chunks), which the per-PTY SSE proxy already parses.
- The `/ws/pty` input channel already whitelists the required keys
  (`RAW_KEY_INPUTS`: `\x1b[A`, `\x1b[B`, `\x1b[C`, `\x1b[D`, `\r`, `\x1b`, `\t`,
  `\x03`). The CLI/terminal view already answers this selector with the
  keyboard today — so the keystroke transport is proven; this feature mirrors it
  into the chat view.

## Approach (chosen: A — drive the native selector from chat)

Faithful to the real tool: the model receives a genuine tool_result and
continues; terminal and chat stay in sync because both drive the same selector.

### v1 scope cut

**Single-select questions only.** Multi-select questions (checkbox `☐`,
toggle-then-submit) render read-only with a hint to answer in the terminal view.
Multi-select driving is a follow-up.

## Components

### 1. Re-enable the tool
`packages/jinn/src/engines/claude-interactive.ts`

- `buildInteractiveArgs`: `--disallowedTools AskUserQuestion ExitPlanMode`
  → `--disallowedTools ExitPlanMode`.
- `ensureIdleSpawn`: same change to its inline args array.

### 2. Detect + extract the question (backend, SSE path)
`packages/jinn/src/engines/claude-interactive.ts` +
`packages/jinn/src/engines/sse-pty-proxy.ts` (whichever owns event assembly)

- Track per-turn tool_use blocks by `content_block` index/id.
- On `content_block_start` with `tool_use` name `AskUserQuestion`, begin
  accumulating subsequent `input_json_delta.partial_json` for that block.
- On `content_block_stop` for that block, `JSON.parse` the assembled input and
  emit a **`block` delta** (`op: "put"`) of type `question` — mirroring the
  existing `task-list` emission pattern (`hermes-protocol.ts`).
- Keep the existing behaviour that `input_json_delta` is otherwise not surfaced
  to the chat pane; only the AskUserQuestion block is assembled.

### 3. New `question` chat-block type
`packages/jinn/src/shared/types.ts` and `packages/web/src/lib/blocks.ts`

- Add `"question"` to `ChatBlockType` (both files) and to
  `SUPPORTED_BLOCK_TYPES` in `blocks.ts`.
- Payload shape:
  ```ts
  {
    toolId: string,
    answered?: boolean,
    questions: Array<{
      header: string,
      question: string,
      multiSelect: boolean,
      options: Array<{ label: string, description?: string }>,
    }>,
  }
  ```
- `blockFallbackContent`/validation updated for the new type (CLI/connector
  transports fall back to text).

### 4. Render in chat (frontend)
`packages/web/src/components/chat/chat-blocks.tsx`

- Render header + question text; each option is a clickable button showing
  label + description.
- Single-select: clicking an option sends the answer (see §5), then all buttons
  disable and the chosen one is highlighted.
- Multi-select (`multiSelect: true`): render options read-only with a
  "answer in the terminal view" hint (v1 cut).
- Once `answered` is true (locally set on click, or arriving via a block
  `patch`), the block is inert.

### 5. Answer transport — drive the native selector
`packages/jinn/src/gateway/pty-ws.ts` + `InteractiveClaudeEngine`

- Add a semantic pty-ws message: `{ type: "answerQuestion", toolId, selections }`
  where `selections` is a per-question chosen option index (v1: one question,
  one index). Keeping the fragile key-mapping server-side makes it unit-testable.
- Handler calls a new engine method `answerQuestion(sessionId, selections)` that
  writes keystrokes to the live PTY via the existing `writeRaw` path:
  - Cursor starts at index 0. For a single-select question at chosen index `k`:
    write `\x1b[B` (Down) `k` times, then `\r` (Enter).
  - Multi-question (future-safe sequencing): after each Enter the selector
    advances to the next question; replay Down×k + Enter per question in order.
- The block is marked `answered` on first send; further clicks are ignored to
  avoid double-driving when the terminal view is also open.

### 6. Sync / lifecycle
- When the turn continues after an answer (next tool_result / assistant text /
  Stop), emit a block `patch` setting `answered/status: done` so the chat block
  closes regardless of whether the answer came from chat or the terminal view.

## Data flow

```
claude PTY --SSE--> proxy --content_block_start/input_json_delta/stop-->
  engine assembles AskUserQuestion input
  --> StreamDelta{ type:"block", block:{op:"put", block:{type:"question", payload}} }
  --> web chat renders clickable options

user clicks option k
  --> /ws/pty  { type:"answerQuestion", toolId, selections:[k] }
  --> pty-ws --> engine.answerQuestion() --> writeRaw: Down×k + Enter
  --> native selector confirms --> claude gets tool_result --> turn continues
  --> engine emits block patch { answered:true } --> chat block inert
```

## Error handling & edge cases

- **Malformed/partial tool input:** if `JSON.parse` of the assembled input fails,
  do not emit a `question` block; the selector still works in the terminal view.
- **Stale click:** clicks after `answered` are ignored (server also no-ops if no
  matching active selector).
- **Race with terminal keyboard:** first answer wins; block marked answered.
- **Multi-select in v1:** rendered read-only; no keystrokes sent.
- **Non-chat transports (CLI/connector):** ignore the block delta, fall back to
  text (existing behaviour).

## Testing

- **Unit (backend):** SSE event sequence (`content_block_start` +
  `input_json_delta*` + `content_block_stop`) for `AskUserQuestion` assembles
  the correct payload and emits a `question` block; non-AskUserQuestion tools are
  unaffected.
- **Unit (keystrokes):** `answerQuestion` produces `Down×k + Enter` for a given
  index; index 0 → just `Enter`.
- **Unit (frontend):** `blocks.ts` accepts/validates the `question` type;
  `chat-blocks.tsx` renders options, single-select click sends the expected
  pty-ws message and disables, multi-select renders read-only.
- **Manual/e2e:** in the running gateway, prompt Claude to ask a single-select
  question; confirm options render in chat, clicking one advances the turn, and
  the block closes.

## Out of scope

- `ExitPlanMode` / plan approvals.
- Multi-select driving (follow-up).
- `Type something.` free-text answering and `Chat about this` from chat.
- Other engines (codex/grok/hermes) — Claude only.
