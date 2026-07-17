# AskUserQuestion → Selectable Chat Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-enable Claude's `AskUserQuestion` tool in the interactive engine and surface its choices as clickable options in the web chat view, routing the pick back to the live PTY so the turn continues.

**Architecture:** The per-PTY SSE proxy already parses the assistant stream. We accumulate the `AskUserQuestion` tool_use input (`input_json_delta`) into a structured question, emit it as a new `question` chat-block delta (same pipeline as the existing `task-list` block), render clickable options in chat, and answer by POSTing the selection to a REST endpoint that drives the native TUI selector via keystrokes (`Down × index` + `Enter`).

**Tech Stack:** TypeScript, node-pty, Node http gateway, React (web), Vitest.

## Global Constraints

- Verified against Claude Code **2.1.209**: `AskUserQuestion` renders a native TUI selector; navigation is `↑`/`↓` (`\x1b[A`/`\x1b[B`) + `Enter` (`\r`); cursor starts at option index 0; digit keys do NOT select.
- The **PreToolUse hook does NOT fire** for `AskUserQuestion` — structured data comes only from the SSE `input_json_delta` stream.
- `ExitPlanMode` stays disabled. Only `AskUserQuestion` is re-enabled.
- **v1 = single-select only.** Multi-select questions render read-only with a "answer in the terminal view" hint; no keystrokes are sent for them.
- Down key = `"\x1b[B"`, Enter = `"\r"` (already whitelisted in `RAW_KEY_INPUTS`, pty-ws.ts:7).
- Block emission mirrors the existing `task-list` pattern in `hermes-protocol.ts` and the `ChatBlockEnvelope` type in `packages/jinn/src/shared/types.ts`.
- Run tests from `packages/jinn` (`pnpm test`) and `packages/web` (`pnpm test`) respectively. `pnpm` is at `~/.nvm/versions/node/v24.18.0/bin/pnpm` if not on PATH.

---

### Task 1: Add the `question` block type (shared + web block model)

**Files:**
- Modify: `packages/jinn/src/shared/types.ts:3`
- Modify: `packages/web/src/lib/blocks.ts:3` and `:27`
- Test: `packages/web/src/lib/__tests__/blocks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatBlockType` now includes `"question"`; `question` block `payload` shape:
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

- [ ] **Step 1: Write the failing test**

Add to `packages/web/src/lib/__tests__/blocks.test.ts`:

```ts
import { isChatBlock } from '../blocks'

it('accepts a question block', () => {
  const block = {
    id: 'q-tool_1', type: 'question', version: 1,
    payload: {
      toolId: 'tool_1', answered: false,
      questions: [{ header: 'Color', question: 'Pick a color', multiSelect: false,
        options: [{ label: 'Red', description: 'The color red' }] }],
    },
  }
  expect(isChatBlock(block)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && pnpm test -- blocks.test`
Expected: FAIL — `isChatBlock` returns false because `"question"` is not in `SUPPORTED_BLOCK_TYPES`.

- [ ] **Step 3: Add the type in both files**

In `packages/jinn/src/shared/types.ts:3`:

```ts
export type ChatBlockType = "task-list" | "question";
```

In `packages/web/src/lib/blocks.ts:3`:

```ts
export type ChatBlockType = 'task-list' | 'question'
```

In `packages/web/src/lib/blocks.ts:27`:

```ts
const SUPPORTED_BLOCK_TYPES = new Set<ChatBlockType>(['task-list', 'question'])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && pnpm test -- blocks.test`
Expected: PASS

- [ ] **Step 5: Extend `blockFallbackContent` for the new type**

In `packages/web/src/lib/blocks.ts`, inside `blockFallbackContent`, before the final `return prefix`:

```ts
  if (block.type === 'question') {
    const questions = Array.isArray(block.payload.questions) ? block.payload.questions : []
    const first = questions[0] as { question?: string } | undefined
    return first?.question ? `${prefix}: ${first.question}` : prefix
  }
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd packages/jinn && pnpm typecheck && cd ../web && pnpm typecheck`
Expected: no errors.

```bash
git add packages/jinn/src/shared/types.ts packages/web/src/lib/blocks.ts packages/web/src/lib/__tests__/blocks.test.ts
git commit -m "feat(blocks): add question chat-block type"
```

---

### Task 2: Re-enable `AskUserQuestion` in the engine args

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts:197` (buildInteractiveArgs)
- Modify: `packages/jinn/src/engines/claude-interactive.ts:977` (ensureIdleSpawn args)
- Test: `packages/jinn/src/engines/__tests__/claude-interactive.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildInteractiveArgs` no longer lists `AskUserQuestion` in `--disallowedTools`; `ExitPlanMode` remains.

- [ ] **Step 1: Write the failing test**

Add to `packages/jinn/src/engines/__tests__/claude-interactive.test.ts` (import `buildInteractiveArgs` if not already imported):

```ts
it("re-enables AskUserQuestion but keeps ExitPlanMode disabled", () => {
  const args = buildInteractiveArgs({ prompt: "hi", settingsPath: "/s.json" });
  const i = args.indexOf("--disallowedTools");
  expect(i).toBeGreaterThan(-1);
  // The tokens immediately after --disallowedTools are the disallowed tool names.
  const disallowed = args.slice(i + 1, i + 3);
  expect(disallowed).toContain("ExitPlanMode");
  expect(disallowed).not.toContain("AskUserQuestion");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm test -- claude-interactive.test`
Expected: FAIL — `disallowed` still contains `AskUserQuestion`.

- [ ] **Step 3: Update both arg sites**

In `packages/jinn/src/engines/claude-interactive.ts:197`:

```ts
  args.push("--disallowedTools", "ExitPlanMode");
```

In `packages/jinn/src/engines/claude-interactive.ts:977` (inside `ensureIdleSpawn`'s `args` array), change the line:

```ts
      "--disallowedTools", "ExitPlanMode",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm test -- claude-interactive.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/engines/claude-interactive.ts packages/jinn/src/engines/__tests__/claude-interactive.test.ts
git commit -m "feat(claude): re-enable AskUserQuestion tool"
```

---

### Task 3: Assemble the AskUserQuestion tool input from SSE into a question block

**Files:**
- Create: `packages/jinn/src/engines/ask-user-question.ts`
- Test: `packages/jinn/src/engines/__tests__/ask-user-question.test.ts`

**Interfaces:**
- Consumes: `SseDataEvent` (from `sse-pty-proxy.ts`) — a parsed Anthropic SSE `data:` event with a `type` field. Relevant shapes:
  - `content_block_start`: `{ type, index: number, content_block: { type: "tool_use", id: string, name: string, input: object } }`
  - `content_block_delta`: `{ type, index: number, delta: { type: "input_json_delta", partial_json: string } }`
  - `content_block_stop`: `{ type, index: number }`
- Produces:
  - `class AskUserQuestionAssembler` with:
    - `onEvent(e: SseDataEvent): QuestionBlockPayload | null` — returns the assembled payload exactly once, on the `content_block_stop` of an `AskUserQuestion` tool_use block; otherwise `null`.
    - `reset(): void` — clears in-progress state (called at turn start).
  - `type QuestionBlockPayload` = the payload shape from Task 1.
  - `function parseAskUserQuestionInput(input: unknown): QuestionBlockPayload["questions"] | null` — normalizes Claude's tool input to the questions array; returns `null` if unusable.

- [ ] **Step 1: Write the failing test**

Create `packages/jinn/src/engines/__tests__/ask-user-question.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AskUserQuestionAssembler } from "../ask-user-question.js";

describe("AskUserQuestionAssembler", () => {
  it("assembles a single-select question from split input_json_delta chunks", () => {
    const a = new AskUserQuestionAssembler();
    expect(a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: {} } })).toBeNull();
    const full = JSON.stringify({ questions: [{ header: "Color", question: "Pick a color",
      multiSelect: false, options: [{ label: "Red", description: "The color red" }, { label: "Green" }] }] });
    const mid = Math.floor(full.length / 2);
    expect(a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: full.slice(0, mid) } })).toBeNull();
    expect(a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: full.slice(mid) } })).toBeNull();
    const payload = a.onEvent({ type: "content_block_stop", index: 0 });
    expect(payload).not.toBeNull();
    expect(payload!.toolId).toBe("toolu_1");
    expect(payload!.answered).toBe(false);
    expect(payload!.questions[0]).toEqual({ header: "Color", question: "Pick a color",
      multiSelect: false, options: [{ label: "Red", description: "The color red" }, { label: "Green", description: undefined }] });
  });

  it("ignores non-AskUserQuestion tool_use blocks", () => {
    const a = new AskUserQuestionAssembler();
    a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_2", name: "Bash", input: {} } });
    a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } });
    expect(a.onEvent({ type: "content_block_stop", index: 0 })).toBeNull();
  });

  it("returns null when the assembled JSON is malformed", () => {
    const a = new AskUserQuestionAssembler();
    a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_3", name: "AskUserQuestion", input: {} } });
    a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{ not json' } });
    expect(a.onEvent({ type: "content_block_stop", index: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm test -- ask-user-question.test`
Expected: FAIL — module `../ask-user-question.js` not found.

- [ ] **Step 3: Implement the assembler**

Create `packages/jinn/src/engines/ask-user-question.ts`:

```ts
import type { SseDataEvent } from "./sse-pty-proxy.js";

export interface QuestionOption { label: string; description?: string; }
export interface QuestionSpec {
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}
export interface QuestionBlockPayload {
  toolId: string;
  answered: boolean;
  questions: QuestionSpec[];
}

/** Normalize Claude's AskUserQuestion tool input into our question specs.
 *  Claude sends `{ questions: [{ header, question, multiSelect?, options: [{ label, description? }] }] }`.
 *  Returns null if the shape is unusable (no questions / no options). */
export function parseAskUserQuestionInput(input: unknown): QuestionSpec[] | null {
  if (!input || typeof input !== "object") return null;
  const rawQs = (input as Record<string, unknown>).questions;
  if (!Array.isArray(rawQs) || rawQs.length === 0) return null;
  const questions: QuestionSpec[] = [];
  for (const rq of rawQs) {
    if (!rq || typeof rq !== "object") continue;
    const q = rq as Record<string, unknown>;
    const rawOpts = Array.isArray(q.options) ? q.options : [];
    const options: QuestionOption[] = [];
    for (const ro of rawOpts) {
      if (ro && typeof ro === "object") {
        const o = ro as Record<string, unknown>;
        if (typeof o.label === "string") {
          options.push({ label: o.label, description: typeof o.description === "string" ? o.description : undefined });
        }
      } else if (typeof ro === "string") {
        options.push({ label: ro, description: undefined });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      header: typeof q.header === "string" ? q.header : "",
      question: typeof q.question === "string" ? q.question : "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** Accumulates the AskUserQuestion tool_use block's input across SSE events for a
 *  single turn. Tracks the content-block index that belongs to an AskUserQuestion
 *  tool_use, concatenates its input_json_delta chunks, and on content_block_stop
 *  parses + returns the payload exactly once. Non-AskUserQuestion blocks are ignored. */
export class AskUserQuestionAssembler {
  private activeIndex: number | undefined;
  private toolId = "";
  private buf = "";

  reset(): void {
    this.activeIndex = undefined;
    this.toolId = "";
    this.buf = "";
  }

  onEvent(e: SseDataEvent): QuestionBlockPayload | null {
    const type = e.type;
    if (type === "content_block_start") {
      const cb = (e as any).content_block;
      if (cb?.type === "tool_use" && cb?.name === "AskUserQuestion") {
        this.activeIndex = (e as any).index;
        this.toolId = String(cb.id ?? "");
        this.buf = "";
      }
      return null;
    }
    if (this.activeIndex === undefined) return null;
    if (type === "content_block_delta" && (e as any).index === this.activeIndex) {
      const d = (e as any).delta;
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string") this.buf += d.partial_json;
      return null;
    }
    if (type === "content_block_stop" && (e as any).index === this.activeIndex) {
      const toolId = this.toolId;
      const buf = this.buf;
      this.activeIndex = undefined;
      this.toolId = "";
      this.buf = "";
      let parsed: unknown;
      try { parsed = JSON.parse(buf); } catch { return null; }
      const questions = parseAskUserQuestionInput(parsed);
      if (!questions) return null;
      return { toolId, answered: false, questions };
    }
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/jinn && pnpm test -- ask-user-question.test`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/jinn/src/engines/ask-user-question.ts packages/jinn/src/engines/__tests__/ask-user-question.test.ts
git commit -m "feat(claude): assemble AskUserQuestion input from SSE into question payload"
```

---

### Task 4: Emit the question block delta + drive the selector (engine)

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts` (imports; `active` map entry; `handleSseEvent`; add `answerQuestion` method; reset assembler at turn start)
- Test: `packages/jinn/src/engines/__tests__/claude-interactive.test.ts`

**Interfaces:**
- Consumes: `AskUserQuestionAssembler`, `QuestionBlockPayload` (Task 3).
- Produces:
  - `handleSseEvent` emits `{ type: "block", content, block: { op: "put", block: { id: \`askq-<toolId>\`, type: "question", version: 1, sourceEngine: "claude", title, payload } } }` on the active turn's `onStream` when a question is assembled.
  - `InteractiveClaudeEngine.answerQuestion(sessionId: string, selections: number[]): boolean` — writes `Down × selections[i]` then `Enter` per question to the live PTY via `writeRaw`; returns `false` if no warm PTY. v1 uses only `selections[0]` for the first (single-select) question but the method accepts the full array for forward-compatibility.

- [ ] **Step 1: Write the failing test for `answerQuestion` keystrokes**

Add to `packages/jinn/src/engines/__tests__/claude-interactive.test.ts`. This uses a fake lifecycle exposing a warm PTY whose `write` is recorded. If the existing test file already has a lifecycle/PTY test harness, reuse it; otherwise add this minimal one:

```ts
import { InteractiveClaudeEngine } from "../claude-interactive.js";

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

it("answerQuestion writes Down×index then Enter for a single-select pick", () => {
  const writes: string[] = [];
  const engine = engineWithFakePty(writes);
  const ok = engine.answerQuestion("jinn-1", [2]);
  expect(ok).toBe(true);
  expect(writes).toEqual(["\x1b[B", "\x1b[B", "\r"]);
});

it("answerQuestion picks the first option with just Enter (index 0)", () => {
  const writes: string[] = [];
  const engine = engineWithFakePty(writes);
  engine.answerQuestion("jinn-1", [0]);
  expect(writes).toEqual(["\r"]);
});

it("answerQuestion returns false when there is no warm PTY", () => {
  const lifecycle: any = { getWarm: () => undefined, onRelease: () => {} };
  const engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
  expect(engine.answerQuestion("jinn-1", [1])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/jinn && pnpm test -- claude-interactive.test`
Expected: FAIL — `answerQuestion` is not a function.

- [ ] **Step 3: Add the import and per-turn assembler**

In `packages/jinn/src/engines/claude-interactive.ts`, add near the other engine imports (after line 16):

```ts
import { AskUserQuestionAssembler } from "./ask-user-question.js";
```

Change the `active` map entry type (the field is declared on the class at ~line 476) so each turn carries an assembler. Update the declaration:

```ts
  private active = new Map<string, { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: pty.IPty; askq?: AskUserQuestionAssembler }>();
```

In `run()`, where the `entry` object is created (~line 666), add the assembler:

```ts
    const entry: { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: pty.IPty; activeTools: number; askq: AskUserQuestionAssembler } = {
      resolver,
      onStream: opts.onStream,
      activeTools: 0,
      askq: new AskUserQuestionAssembler(),
    };
```

- [ ] **Step 4: Emit the block in `handleSseEvent`**

In `handleSseEvent` (~line 855), after `entry.resolver.noteActivity();` and before the `if (!entry.onStream) return;` guard, add:

```ts
    if (entry.askq && entry.onStream) {
      const payload = entry.askq.onEvent(e);
      if (payload) {
        entry.onStream({
          type: "block",
          content: payload.questions[0]?.question ?? "Question",
          block: {
            op: "put",
            block: {
              id: `askq-${payload.toolId}`,
              type: "question",
              version: 1,
              sourceEngine: "claude",
              title: payload.questions[0]?.header || "Question",
              payload: payload as unknown as Record<string, unknown>,
            },
          },
        });
      }
    }
```

- [ ] **Step 5: Add the `answerQuestion` method**

Add this public method to `InteractiveClaudeEngine` (near `writeStdin`, ~line 1050):

```ts
  /** Answer a live AskUserQuestion selector by driving the native TUI: for each
   *  question, move the cursor Down by the chosen option index (cursor starts at 0)
   *  then press Enter. v1 supports single-select; each entry in `selections` is the
   *  chosen option index for that question, applied in order. Returns false if the
   *  session has no warm PTY (nothing to drive). */
  answerQuestion(sessionId: string, selections: number[]): boolean {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (!proc) return false;
    for (const rawIndex of selections) {
      const index = Number.isFinite(rawIndex) && rawIndex > 0 ? Math.floor(rawIndex) : 0;
      for (let i = 0; i < index; i++) proc.write("\x1b[B");
      proc.write("\r");
    }
    return true;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/jinn && pnpm test -- claude-interactive.test`
Expected: PASS (keystroke cases + the Task 2 case).

- [ ] **Step 7: Typecheck + commit**

Run: `cd packages/jinn && pnpm typecheck`
Expected: no errors.

```bash
git add packages/jinn/src/engines/claude-interactive.ts packages/jinn/src/engines/__tests__/claude-interactive.test.ts
git commit -m "feat(claude): emit question block and drive selector via answerQuestion"
```

---

### Task 5: REST endpoint to answer a question

**Files:**
- Modify: `packages/jinn/src/gateway/api.ts` (add route near the `/stop` handler, ~line 1018)
- Test: `packages/jinn/src/gateway/__tests__/` (add `answer-question` test; if no api test harness exists, cover via the engine unit test in Task 4 and mark this step manual — see Step 2)

**Interfaces:**
- Consumes: `context.interactiveClaudeEngine` (api.ts:203) → `answerQuestion(sessionId, selections)` (Task 4).
- Produces: `POST /api/sessions/:id/answer-question` with body `{ selections: number[] }` → `200 { status: "answered", sessionId }` when driven, `409 { error: "no active session" }` when no warm PTY, `404` when the session is unknown, `400` when `selections` is not an array of numbers.

- [ ] **Step 1: Add the route**

In `packages/jinn/src/gateway/api.ts`, immediately after the `/api/sessions/:id/stop` handler block (after api.ts:1028), add:

```ts
    // POST /api/sessions/:id/answer-question — answer a live AskUserQuestion selector
    params = matchRoute("/api/sessions/:id/answer-question", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const body = await readJsonBody(req).catch(() => null);
      const selections = (body as { selections?: unknown } | null)?.selections;
      if (!Array.isArray(selections) || !selections.every((n) => typeof n === "number")) {
        return json(res, { error: "selections must be a number[]" }, 400);
      }
      const engine = context.interactiveClaudeEngine;
      const ok = engine?.answerQuestion(params.id, selections as number[]) ?? false;
      if (!ok) return json(res, { error: "no active session" }, 409);
      return json(res, { status: "answered", sessionId: params.id });
    }
```

Note: reuse whatever JSON-body reader and `json`/`notFound` helpers the surrounding handlers use. Confirm the exact name of the body reader by checking the `/message` handler (`grep -n "readJsonBody\|parseBody\|await readBody\|JSON.parse" packages/jinn/src/gateway/api.ts | head`) and substitute it for `readJsonBody` above if different. Confirm `json(res, body, status)` signature the same way.

- [ ] **Step 2: Verify via a quick manual curl (no api unit harness)**

Rebuild and restart is covered in Task 7. For an isolated check now, run typecheck only:

Run: `cd packages/jinn && pnpm typecheck`
Expected: no errors. (Endpoint behavior is exercised end-to-end in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add packages/jinn/src/gateway/api.ts
git commit -m "feat(gateway): POST /answer-question drives the AskUserQuestion selector"
```

---

### Task 6: Render the question block + wire the answer (web)

**Files:**
- Modify: `packages/web/src/lib/api.ts` (add `answerQuestion` client, near api.ts:324)
- Modify: `packages/web/src/components/chat/chat-blocks.tsx` (render `question` blocks)
- Modify: `packages/web/src/components/chat/chat-messages.tsx:791` (pass `sessionId` to the block renderer if not already available)
- Test: `packages/web/src/components/chat/__tests__/chat-blocks.test.tsx`

**Interfaces:**
- Consumes: `POST /api/sessions/:id/answer-question` (Task 5); `question` block payload (Task 1).
- Produces: `api.answerQuestion(id: string, selections: number[]): Promise<...>`; a `QuestionBlock` React component rendered by `ChatBlockInline` when `block.type === 'question'`.

- [ ] **Step 1: Add the API client method**

In `packages/web/src/lib/api.ts`, next to the existing `stop` method (~line 326):

```ts
  answerQuestion: (id: string, selections: number[]) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/answer-question`, { selections }),
```

- [ ] **Step 2: Write the failing component test**

Add to `packages/web/src/components/chat/__tests__/chat-blocks.test.tsx` (follow the file's existing render/import conventions):

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import { ChatBlockInline } from '../chat-blocks'
import { api } from '@/lib/api'

const questionBlock = {
  id: 'askq-tool_1', type: 'question' as const, version: 1,
  payload: {
    toolId: 'tool_1', answered: false,
    questions: [{ header: 'Color', question: 'Pick a color', multiSelect: false,
      options: [{ label: 'Red', description: 'The color red' }, { label: 'Green' }] }],
  },
}

it('renders question options and answers on click', () => {
  const spy = vi.spyOn(api, 'answerQuestion').mockResolvedValue({ status: 'answered', sessionId: 's1' })
  render(<ChatBlockInline block={questionBlock} sessionId="s1" />)
  expect(screen.getByText('Pick a color')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Green/ }))
  expect(spy).toHaveBeenCalledWith('s1', [1])
})

it('renders multi-select read-only (no answer call)', () => {
  const spy = vi.spyOn(api, 'answerQuestion').mockResolvedValue({ status: 'answered', sessionId: 's1' })
  const multi = { ...questionBlock, payload: { ...questionBlock.payload,
    questions: [{ ...questionBlock.payload.questions[0], multiSelect: true }] } }
  render(<ChatBlockInline block={multi} sessionId="s1" />)
  expect(screen.getByText(/terminal view/i)).toBeInTheDocument()
  expect(spy).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/web && pnpm test -- chat-blocks.test`
Expected: FAIL — `ChatBlockInline` does not accept `sessionId` / does not render a question.

- [ ] **Step 4: Add the `sessionId` prop and question rendering**

In `packages/web/src/components/chat/chat-blocks.tsx`, change the `ChatBlockInline` signature and dispatch on type. Replace the current `export function ChatBlockInline({ block }: { block: ChatBlock })` opening with:

```tsx
export function ChatBlockInline({ block, sessionId }: { block: ChatBlock; sessionId?: string }) {
  if (block.type === 'question') return <QuestionBlock block={block} sessionId={sessionId} />
  // ... existing task-list body unchanged ...
```

Add the `QuestionBlock` component in the same file:

```tsx
import { useState } from 'react'
import { api } from '@/lib/api'

function QuestionBlock({ block, sessionId }: { block: ChatBlock; sessionId?: string }) {
  const [answered, setAnswered] = useState<boolean>(block.payload.answered === true)
  const [picked, setPicked] = useState<number | null>(null)
  const questions = asArray(block.payload.questions)
  const q = asRecord(questions[0])
  if (!q) return null
  const multiSelect = q.multiSelect === true
  const options = asArray(q.options)

  async function pick(index: number) {
    if (answered || multiSelect || !sessionId) return
    setAnswered(true)
    setPicked(index)
    try { await api.answerQuestion(sessionId, [index]) } catch { setAnswered(false); setPicked(null) }
  }

  return (
    <div className={`grid min-w-0 ${INLINE_MAX_WIDTH} gap-1 py-0.5`} data-block-id={block.id} data-block-type="question">
      <div className="px-0.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
        {asText(q.header) || 'Question'}
      </div>
      <div className="px-0.5 text-[length:var(--text-body)] text-[var(--text-primary)]">{asText(q.question)}</div>
      <div className="grid gap-1">
        {options.map((raw, i) => {
          const o = asRecord(raw)
          const label = asText(o?.label)
          const desc = asText(o?.description)
          return (
            <button
              key={i}
              type="button"
              disabled={answered || multiSelect || !sessionId}
              onClick={() => pick(i)}
              className={`rounded-md border px-2 py-1 text-left text-[length:var(--text-footnote)] ${picked === i ? 'border-[var(--system-blue)]' : 'border-[var(--separator)]'} disabled:opacity-60`}
            >
              <span className="font-[var(--weight-medium)] text-[var(--text-primary)]">{label}</span>
              {desc && <span className="ml-1 text-[var(--text-tertiary)]">— {desc}</span>}
            </button>
          )
        })}
      </div>
      {multiSelect && (
        <div className="px-0.5 text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          Multi-select — answer in the terminal view.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Pass `sessionId` at the call site**

In `packages/web/src/components/chat/chat-messages.tsx:791`, update the render to pass the session id available in that component's scope (confirm the prop name with `grep -n "sessionId\|session\.id\|props\." packages/web/src/components/chat/chat-messages.tsx | head`):

```tsx
                  <ChatBlockInline block={block} sessionId={sessionId} />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/web && pnpm test -- chat-blocks.test`
Expected: PASS (both cases).

- [ ] **Step 7: Typecheck + commit**

Run: `cd packages/web && pnpm typecheck`
Expected: no errors.

```bash
git add packages/web/src/lib/api.ts packages/web/src/components/chat/chat-blocks.tsx packages/web/src/components/chat/chat-messages.tsx packages/web/src/components/chat/__tests__/chat-blocks.test.tsx
git commit -m "feat(web): render AskUserQuestion choices as clickable chat options"
```

---

### Task 7: End-to-end verification in the running gateway

**Files:** none (manual verification).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: confirmation that the full flow works against Claude Code 2.1.209.

- [ ] **Step 1: Build**

Run: `cd packages/jinn && pnpm build && cd ../web && pnpm build`
Expected: both builds succeed. Confirm the key from earlier work is still present: `grep -c skipDangerousModePermissionPrompt packages/jinn/dist/src/shared/claude-settings.js` → `2`.

- [ ] **Step 2: Restart the gateway**

Run (full path in case pnpm is not on PATH):
`~/.nvm/versions/node/v24.18.0/bin/pnpm stop && ~/.nvm/versions/node/v24.18.0/bin/pnpm start`
Expected: gateway boots (`listening on http://127.0.0.1:7777`).

- [ ] **Step 3: Drive a real question**

In a new chat, send: `Use AskUserQuestion to ask me "Pick a color" with options Red, Green, Blue.`
Expected in the **chat view**: a question block renders with clickable Red/Green/Blue buttons.

- [ ] **Step 4: Click an option and confirm continuation**

Click `Green`.
Expected: the buttons disable with Green highlighted; the turn continues and Claude's reply reflects the "Green" choice (cross-check the terminal view shows the selector confirmed on Green). Confirm no hang and the block becomes inert.

- [ ] **Step 5: Confirm ExitPlanMode is still disabled**

Send: `Enter plan mode and propose a plan.`
Expected: Claude cannot call ExitPlanMode (behaves as before this feature — no plan-approval block).

- [ ] **Step 6: Commit any doc/status note if needed**

No code changes expected here. If Steps 3–5 reveal a keystroke miscount (e.g. the selector's first row is not index 0 in some layout), fix `answerQuestion` in Task 4 and re-run.

---

## Self-Review

**Spec coverage:**
- Re-enable tool → Task 2. ✓
- Detect/extract via SSE → Task 3. ✓
- New `question` block type → Task 1. ✓
- Render in chat → Task 6. ✓
- Answer transport (drive selector) → Task 4 (`answerQuestion`) + Task 5 (REST) + Task 6 (click). Transport is REST, not pty-ws: the chat view has no pty-ws socket (that's the terminal view), so a REST endpoint mirroring `/stop` is the correct surface. This supersedes the spec's pty-ws message and is noted here intentionally. ✓
- Sync/lifecycle (block goes inert on answer) → handled client-side (`answered` state) in Task 6; server-side patch-on-continue is deferred (optimistic disable is sufficient for v1; the block naturally scrolls above new output). Noted as a v1 simplification. ✓
- Single-select v1 cut; multi-select read-only → Task 6 Step 4. ✓
- Testing (backend SSE assembly, keystroke mapping, frontend render/click) → Tasks 3, 4, 6. ✓

**Placeholder scan:** No TBD/TODO. Two steps ask the implementer to confirm an exact local helper name via `grep` (JSON body reader in api.ts; sessionId prop in chat-messages.tsx) — these are verification instructions with the exact grep command, not placeholders.

**Type consistency:** `QuestionBlockPayload`/`QuestionSpec`/`QuestionOption` defined in Task 3 and consumed unchanged in Task 4. `answerQuestion(sessionId, selections: number[])` signature identical across Tasks 4, 5, 6. Block id `askq-<toolId>` consistent between Task 4 (emit) and Task 6 (render, keyed by type not id). `question` block type string identical across Tasks 1, 3, 4, 6.

**Deviation from spec noted:** answer transport is a REST endpoint (`POST /api/sessions/:id/answer-question`) rather than the pty-ws `answerQuestion` message named in the spec, because the chat view communicates over REST. Server still owns the keystroke mapping (in the engine), preserving the spec's intent.
