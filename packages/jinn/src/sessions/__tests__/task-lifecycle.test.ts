import { describe, it, expect } from "vitest";
import { deriveLifecycleState, isArchiveEligible } from "../task-lifecycle.js";

describe("deriveLifecycleState", () => {
  it("running/waiting status → running", () => {
    expect(deriveLifecycleState({ status: "running", totalTurns: 2 })).toBe("running");
    expect(deriveLifecycleState({ status: "waiting", totalTurns: 0 })).toBe("running");
  });
  it("idle with turns → done; idle without turns → todo", () => {
    expect(deriveLifecycleState({ status: "idle", totalTurns: 3 })).toBe("done");
    expect(deriveLifecycleState({ status: "idle", totalTurns: 0 })).toBe("todo");
  });
  it("explicit lifecycleState overrides derivation", () => {
    expect(deriveLifecycleState({ lifecycleState: "archived", status: "running", totalTurns: 5 })).toBe("archived");
    expect(deriveLifecycleState({ lifecycleState: "todo", status: "idle", totalTurns: 9 })).toBe("todo");
  });
});

describe("isArchiveEligible", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-07-20T00:00:00Z");
  const done = (lastActivity: string) => ({ sessionRole: "task", status: "idle", totalTurns: 4, lastActivity });

  it("done task idle > 7 days → eligible", () => {
    expect(isArchiveEligible(done("2026-07-10T00:00:00Z"), now)).toBe(true);
  });
  it("done task idle < 7 days → not eligible", () => {
    expect(isArchiveEligible(done("2026-07-18T00:00:00Z"), now)).toBe(false);
  });
  it("home chats are never eligible", () => {
    expect(isArchiveEligible({ ...done("2026-01-01T00:00:00Z"), sessionRole: "home" }, now)).toBe(false);
  });
  it("running / not-yet-done tasks are never eligible", () => {
    expect(isArchiveEligible({ sessionRole: "task", status: "running", totalTurns: 1, lastActivity: "2026-01-01T00:00:00Z" }, now)).toBe(false);
    expect(isArchiveEligible({ sessionRole: "task", status: "idle", totalTurns: 0, lastActivity: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });
  it("already archived → not eligible", () => {
    expect(isArchiveEligible({ ...done("2026-01-01T00:00:00Z"), lifecycleState: "archived" }, now)).toBe(false);
  });
});
