# AskUserQuestion Settings Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a config-driven toggle (`sessions.interactiveQuestions`, default on) that blocks Claude's AskUserQuestion tool via `--disallowedTools` when off.

**Architecture:** Add one optional config field. Replace the frozen `DISALLOWED_TOOLS` const with a `disallowedTools(allow)` helper. Both PTY spawn paths read the config value at spawn time and pass the computed list to the CLI. A `ToggleSwitch` in the web Settings → Sessions section writes the field through the existing config PATCH flow.

**Tech Stack:** TypeScript, Node, Vitest, React (web settings page).

## Global Constraints

- Default is **on** (opt-out): a missing/undefined `sessions.interactiveQuestions` reads as `true` via `?? true`.
- Setting lives in gateway config (`config.yaml`), never browser `localStorage`.
- "Off" = tool blocked entirely (added to `--disallowedTools`), not merely hidden in the UI.
- Single source of truth for the disallowed-tools list across both spawn paths.
- Reading config inside the two impure spawn methods; no new plumbing through `EngineRunOpts` or `pty-ws`.
- Subagent question surfacing is OUT OF SCOPE (separate follow-up spec).
- Run all `jinn` package tests with `pnpm --filter jinn-cli test` (vitest). Run a single file with `pnpm --filter jinn-cli test <path>`.

---

### Task 1: Config schema field

**Files:**
- Modify: `packages/jinn/src/shared/types.ts:617-625` (the `sessions?` block)

**Interfaces:**
- Produces: `JinnConfig["sessions"]["interactiveQuestions"]?: boolean`

- [ ] **Step 1: Add the field to the `sessions` block**

In `packages/jinn/src/shared/types.ts`, inside the `sessions?: { ... }` object (currently lines 617-625), add the field immediately after `interruptOnNewMessage?: boolean;`:

```ts
    interruptOnNewMessage?: boolean;
    /** Allow Claude's interactive AskUserQuestion tool (clickable chat options). Default: true. */
    interactiveQuestions?: boolean;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter jinn-cli typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/jinn/src/shared/types.ts
git commit -m "feat(config): add sessions.interactiveQuestions field"
```

---

### Task 2: `disallowedTools()` helper + thread through `buildInteractiveArgs`

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts:24` (replace const), `:26-40` (`InteractiveArgsOpts`), `:203` (spawn-args builder)
- Test: `packages/jinn/src/engines/__tests__/claude-interactive.test.ts:212-227`

**Interfaces:**
- Produces: `disallowedTools(allowAskUserQuestion: boolean): string[]`
- Produces: `InteractiveArgsOpts.allowAskUserQuestion?: boolean` (default `true`)
- Removes: the `DISALLOWED_TOOLS` exported const (callers migrate to `disallowedTools(...)`)

- [ ] **Step 1: Update the existing failing tests**

The current tests reference the `DISALLOWED_TOOLS` const, which this task removes. Replace the entire `describe("buildInteractiveArgs — disallowed tools", ...)` block (lines 212-227) in `packages/jinn/src/engines/__tests__/claude-interactive.test.ts` with:

```ts
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
```

Then update the test import on line 10: remove `DISALLOWED_TOOLS`, add `disallowedTools`:

```ts
import { TurnResolver, buildInteractiveArgs, claudeHookToDeltas, sseEventToDeltas, pasteAndSubmit, disallowedTools, InteractiveClaudeEngine } from "../claude-interactive.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter jinn-cli test src/engines/__tests__/claude-interactive.test.ts`
Expected: FAIL — `disallowedTools` is not exported yet (import error / undefined).

- [ ] **Step 3: Replace the const with the helper**

In `packages/jinn/src/engines/claude-interactive.ts`, replace line 24:

```ts
export const DISALLOWED_TOOLS = ["ExitPlanMode"] as const;
```

with:

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

- [ ] **Step 4: Add `allowAskUserQuestion` to `InteractiveArgsOpts`**

In the `InteractiveArgsOpts` interface (starts line 26), add after `appendSystemPrompt?: string;`:

```ts
  /** Allow the AskUserQuestion tool. Default true; false adds it to --disallowedTools. */
  allowAskUserQuestion?: boolean;
```

- [ ] **Step 5: Use the helper in the args builder**

At line 203, replace:

```ts
  args.push("--disallowedTools", ...DISALLOWED_TOOLS);
```

with:

```ts
  args.push("--disallowedTools", ...disallowedTools(o.allowAskUserQuestion ?? true));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter jinn-cli test src/engines/__tests__/claude-interactive.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/jinn/src/engines/claude-interactive.ts packages/jinn/src/engines/__tests__/claude-interactive.test.ts
git commit -m "feat(claude): disallowedTools() helper gated by allowAskUserQuestion"
```

---

### Task 3: Resolve config in both spawn paths

**Files:**
- Modify: `packages/jinn/src/engines/claude-interactive.ts` — imports, `spawn()` (~962), `ensureIdleSpawn()` (~1014)

**Interfaces:**
- Consumes: `disallowedTools()` and `InteractiveArgsOpts.allowAskUserQuestion` from Task 2; `loadConfig()` from `../shared/config.js`.

- [ ] **Step 1: Import `loadConfig` and add a local resolver**

At the top of `packages/jinn/src/engines/claude-interactive.ts`, add to the imports (next to the other `../shared/*` imports):

```ts
import { loadConfig } from "../shared/config.js";
```

Then add this module-level helper just below the `disallowedTools` function:

```ts
/** Read the interactive-questions toggle from config. Defaults to true (feature on)
 *  and never throws — if config is unreadable at spawn time, the feature stays on. */
function askUserQuestionAllowed(): boolean {
  try {
    return loadConfig().sessions?.interactiveQuestions ?? true;
  } catch {
    return true;
  }
}
```

- [ ] **Step 2: Pass the flag from `spawn()` into `buildInteractiveArgs`**

In `spawn()` (the `buildInteractiveArgs({ ... })` call near line 962), add to the options object (alongside `model`, `effortLevel`, etc.):

```ts
      allowAskUserQuestion: askUserQuestionAllowed(),
```

- [ ] **Step 3: Use the helper in `ensureIdleSpawn`'s args array**

In `ensureIdleSpawn()` (the `const args: string[] = [ ... ]` near line 1010), replace:

```ts
      "--disallowedTools", ...DISALLOWED_TOOLS,
```

with:

```ts
      "--disallowedTools", ...disallowedTools(askUserQuestionAllowed()),
```

- [ ] **Step 4: Typecheck (confirms no lingering `DISALLOWED_TOOLS` references)**

Run: `pnpm --filter jinn-cli typecheck`
Expected: PASS. If it fails with `Cannot find name 'DISALLOWED_TOOLS'`, replace that reference with `disallowedTools(askUserQuestionAllowed())`.

- [ ] **Step 5: Run the full jinn test suite**

Run: `pnpm --filter jinn-cli test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/jinn/src/engines/claude-interactive.ts
git commit -m "feat(claude): gate AskUserQuestion by config at both spawn paths"
```

---

### Task 4: Settings UI toggle

**Files:**
- Modify: `packages/web/src/routes/settings/page.tsx` — the `Config` interface `sessions?` block (~47-53) and the Sessions `<Section>` (~1090-1129)

**Interfaces:**
- Consumes: existing `ToggleSwitch`, `FieldRow`, `updateConfig`, and `config` from the same file.

- [ ] **Step 1: Add the field to the local `Config` type**

In `packages/web/src/routes/settings/page.tsx`, inside `interface Config { ... sessions?: { ... } }` (around lines 47-53), add after `interruptOnNewMessage?: boolean`:

```ts
    interactiveQuestions?: boolean
```

- [ ] **Step 2: Add the toggle row in the Sessions section**

In the `<Section title="Sessions">` block, immediately after the closing `</div>` of the `interruptOnNewMessage` description paragraph (the block ending "...messages are queued.") and before the `border-t` divider that precedes "When Claude Hits Usage Limit", insert:

```tsx
                <div
                  className="border-t border-[var(--separator)] mt-[var(--space-3)] pt-[var(--space-3)]"
                />

                <FieldRow label="Interactive Questions">
                  <ToggleSwitch
                    checked={config.sessions?.interactiveQuestions ?? true}
                    onChange={(v) =>
                      updateConfig(["sessions", "interactiveQuestions"], v)
                    }
                  />
                </FieldRow>
                <div
                  className="text-[length:var(--text-caption1)] text-[var(--label-secondary)] mt-[4px]"
                >
                  When enabled, Claude can present multiple-choice questions as clickable
                  options in chat. When disabled, it asks in plain text.
                </div>
```

- [ ] **Step 3: Typecheck the web package**

Run: `pnpm --filter @jinn/web typecheck`
Expected: PASS. (If the web package has no `typecheck` script, run `pnpm --filter @jinn/web build` instead and expect a successful build.)

- [ ] **Step 4: Manual verification**

Run the app (`pnpm --filter jinn-cli dev` or the project's usual start), open Settings → Sessions, confirm the **Interactive Questions** toggle renders, defaults to on, and that toggling + Save Config persists (reload the page; the toggle keeps its state).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/routes/settings/page.tsx
git commit -m "feat(web): Interactive Questions toggle in Settings → Sessions"
```

---

## Self-Review

**Spec coverage:**
- Config schema field → Task 1. ✓
- `disallowedTools()` helper + engine gating → Tasks 2 & 3. ✓
- Both spawn paths read config → Task 3 (steps 2 & 3). ✓
- Settings UI toggle in Sessions section → Task 4. ✓
- Default-on via `?? true` → Task 2 (builder), Task 3 (resolver), Task 4 (UI). ✓
- Unit tests for `disallowedTools` and `buildInteractiveArgs` → Task 2. ✓
- Subagent surfacing → correctly excluded (follow-up spec). ✓

**Placeholder scan:** No TBD/TODO; all code steps show full code. ✓

**Type consistency:** `disallowedTools(boolean): string[]`, `InteractiveArgsOpts.allowAskUserQuestion?: boolean`, `askUserQuestionAllowed(): boolean`, and `sessions.interactiveQuestions?: boolean` are consistent across tasks. The `DISALLOWED_TOOLS` const is removed in Task 2 and all references migrated in Tasks 2-3. ✓

**Note on config round-trip test:** The spec listed a config round-trip test as optional ("if a cheap harness exists"). Persistence is instead covered by Task 4's manual verification, since it exercises the real PATCH/GET flow end-to-end.
