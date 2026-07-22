import { describe, it, expect } from "vitest";
import { isBgAgentRefusal, registerExit } from "../bg-agent-guard.js";

describe("isBgAgentRefusal", () => {
  it("matches Claude's background-agent refusal message", () => {
    expect(isBgAgentRefusal(
      "Session daed9178 is currently running as a background agent (bg). Use `claude agents`…",
    )).toBe(true);
  });
  it("does not match ordinary output", () => {
    expect(isBgAgentRefusal("Resuming session… done.")).toBe(false);
    expect(isBgAgentRefusal("")).toBe(false);
  });
});

describe("registerExit (fast-exit circuit breaker)", () => {
  it("increments on fast exits and trips at the limit", () => {
    let r = registerExit(undefined, 500);
    expect(r.tripped).toBe(false);
    r = registerExit(r.record, 500);
    expect(r.tripped).toBe(false);
    r = registerExit(r.record, 500);
    expect(r.tripped).toBe(true);
  });
  it("resets the streak when a PTY lives past the window", () => {
    let r = registerExit(undefined, 500);
    r = registerExit(r.record, 500);
    r = registerExit(r.record, 9000);
    expect(r.record.count).toBe(0);
    expect(r.tripped).toBe(false);
  });
});
