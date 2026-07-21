import { describe, it, expect } from "vitest";
import { capAgentSessions } from "../cap-sessions";

const s = (id: string) => ({ id });

describe("capAgentSessions", () => {
  it("caps to N and reports the remainder", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 2 });
    expect(out.visible.map(x => x.id)).toEqual(["a", "b"]);
    expect(out.hiddenCount).toBe(2);
  });
  it("always includes the active session even past the cap", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 2, activeId: "d" });
    expect(out.visible.map(x => x.id)).toContain("d");
    expect(out.hiddenCount).toBe(1); // c still hidden
  });
  it("always includes pinned sessions past the cap", () => {
    const out = capAgentSessions([s("a"), s("b"), s("c"), s("d")], { cap: 1, isPinned: (x) => x.id === "c" });
    expect(out.visible.map(x => x.id)).toEqual(["a", "c"]);
    expect(out.hiddenCount).toBe(2); // b, d hidden
  });
});
