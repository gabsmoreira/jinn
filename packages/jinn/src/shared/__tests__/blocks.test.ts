import { describe, expect, it } from "vitest";
import {
  blockFallbackText,
  mergeBlock,
  validateBlockEnvelope,
} from "../blocks.js";

describe("chat blocks", () => {
  it("accepts a minimal task-list put envelope", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        payload: {
          items: [
            { id: "a", text: "Read code", status: "done" },
            { id: "b", text: "Patch UI", status: "running" },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(blockFallbackText(result.envelope.block)).toBe("Plan: 2 items");
    }
  });

  it("rejects unsupported block types", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "metric",
        type: "metric",
        version: 1,
        payload: { value: "43k" },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects executable markup and unsafe payload keys", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "bad",
        type: "task-list",
        version: 1,
        payload: {
          items: [{ id: "a", text: "Read code" }],
          dangerouslySetInnerHTML: "<script>alert(1)</script>",
        },
      },
    });

    expect(result.ok).toBe(false);
  });

  it("merges patches without dropping existing payload fields", () => {
    const merged = mergeBlock(
      {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        status: "running",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
      {
        id: "plan",
        type: "task-list",
        version: 1,
        status: "done",
        payload: { summary: "Complete" },
      },
    );

    expect(merged.status).toBe("done");
    expect(merged.payload).toEqual({
      items: [{ id: "a", text: "Read code", status: "running" }],
      summary: "Complete",
    });
  });

  it("does not let patches mutate the block type", () => {
    const merged = mergeBlock(
      {
        id: "plan",
        type: "task-list",
        version: 1,
        title: "Plan",
        status: "running",
        payload: { items: [{ id: "a", text: "Read code", status: "running" }] },
      },
      {
        id: "plan",
        type: "metric",
        version: 1,
        status: "done",
        payload: { resolved: true },
      } as any,
    );

    expect(merged.type).toBe("task-list");
    expect(merged.payload).toMatchObject({
      items: [{ id: "a", text: "Read code", status: "running" }],
      resolved: true,
    });
  });

  it("accepts a valid question put envelope with an option lacking a description", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "askq-x",
        type: "question",
        version: 1,
        payload: {
          toolId: "tool-1",
          answered: false,
          questions: [
            {
              header: "",
              question: "Which approach?",
              multiSelect: false,
              options: [{ label: "Option A" }],
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(blockFallbackText(result.envelope.block)).toBe("question: Which approach?");
    }
  });

  it("rejects a question put with missing questions[]", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "askq-x",
        type: "question",
        version: 1,
        payload: {
          toolId: "tool-1",
          answered: false,
        },
      },
    });

    expect(result).toMatchObject({ ok: false, error: "question payload requires questions[]" });
  });

  it("rejects a question put with empty questions[]", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "askq-x",
        type: "question",
        version: 1,
        payload: {
          toolId: "tool-1",
          answered: false,
          questions: [],
        },
      },
    });

    expect(result).toMatchObject({ ok: false, error: "question payload requires questions[]" });
  });

  it("rejects a question option without a string label", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "askq-x",
        type: "question",
        version: 1,
        payload: {
          toolId: "tool-1",
          answered: false,
          questions: [
            {
              header: "",
              question: "Which approach?",
              multiSelect: false,
              options: [{ description: "no label here" }],
            },
          ],
        },
      },
    });

    expect(result).toMatchObject({ ok: false, error: "question option requires label" });
  });

  it("accepts a question option with a real description", () => {
    const result = validateBlockEnvelope({
      op: "put",
      block: {
        id: "askq-x",
        type: "question",
        version: 1,
        payload: {
          toolId: "tool-1",
          answered: false,
          questions: [
            {
              header: "",
              question: "Which approach?",
              multiSelect: false,
              options: [{ label: "Option A", description: "Detailed rationale" }],
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects obsolete diff and approval block types", () => {
    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "diff",
        type: "diff",
        version: 1,
        payload: { hunks: [{ before: "old", after: "new" }] },
      },
    })).toMatchObject({ ok: false, error: "block type is invalid" });

    expect(validateBlockEnvelope({
      op: "put",
      block: {
        id: "approval",
        type: "approval",
        version: 1,
        payload: { actionId: "block.resolve" },
      },
    })).toMatchObject({ ok: false, error: "block type is invalid" });
  });
});
