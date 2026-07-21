import { describe, it, expect } from "vitest";
import { PtyStreamManager } from "../pty-stream.js";
import type { PtyControlEvent } from "../pty-view-engine.js";

describe("PtyStreamManager.pushControl", () => {
  it("delivers a bg_agent control event to current subscribers", () => {
    const mgr = new PtyStreamManager("TEST", () => false);
    const events: PtyControlEvent[] = [];
    const unsub = mgr.subscribe("s1", () => {}, (e) => events.push(e));
    mgr.pushControl("s1", { type: "bg_agent" });
    expect(events).toContainEqual({ type: "bg_agent" });
    unsub();
  });
  it("is a no-op for an unknown session", () => {
    const mgr = new PtyStreamManager("TEST", () => false);
    expect(() => mgr.pushControl("nope", { type: "bg_agent" })).not.toThrow();
  });
});
