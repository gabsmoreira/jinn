import { describe, it, expect } from "vitest";
import { deriveLifecycleState } from "../task-lifecycle.js";

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
