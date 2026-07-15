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

  it("reset() prevents state bleed across blocks", () => {
    const a = new AskUserQuestionAssembler();
    // Start first block with toolu_A and partial content
    a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_A", name: "AskUserQuestion", input: {} } });
    a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"questions":[{"header":"A",' } });
    // Do NOT send content_block_stop, then reset
    a.reset();
    // Now feed a fresh, complete AskUserQuestion sequence for toolu_B
    a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_B", name: "AskUserQuestion", input: {} } });
    const full = JSON.stringify({ questions: [{ header: "Fresh", question: "New Q",
      options: [{ label: "Option1" }] }] });
    a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: full } });
    const payload = a.onEvent({ type: "content_block_stop", index: 0 });
    expect(payload).not.toBeNull();
    expect(payload!.toolId).toBe("toolu_B");
    expect(payload!.questions.length).toBe(1);
    expect(payload!.questions[0].header).toBe("Fresh");
    expect(payload!.questions[0].question).toBe("New Q");
  });

  it("multiple questions in one payload assemble correctly", () => {
    const a = new AskUserQuestionAssembler();
    a.onEvent({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "toolu_multi", name: "AskUserQuestion", input: {} } });
    const full = JSON.stringify({ questions: [
      { header: "Q1", question: "First question", options: [{ label: "Opt1" }] },
      { header: "Q2", question: "Second question", options: [{ label: "Opt2" }] }
    ] });
    a.onEvent({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: full } });
    const payload = a.onEvent({ type: "content_block_stop", index: 0 });
    expect(payload).not.toBeNull();
    expect(payload!.questions.length).toBe(2);
    expect(payload!.questions[0]).toEqual({ header: "Q1", question: "First question",
      multiSelect: false, options: [{ label: "Opt1", description: undefined }] });
    expect(payload!.questions[1]).toEqual({ header: "Q2", question: "Second question",
      multiSelect: false, options: [{ label: "Opt2", description: undefined }] });
  });
});
