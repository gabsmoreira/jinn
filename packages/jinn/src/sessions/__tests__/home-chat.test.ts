import { describe, it, expect } from "vitest";
import os from "node:os"; import fs from "node:fs"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-task-rw-"));
process.env.JINN_HOME = tmp;
// Dynamic import (not static): a static `import ... from` is hoisted above the
// JINN_HOME assignment above (SESSIONS_DB is resolved at module load), which
// would silently point the registry at the real, non-isolated JINN_HOME instead
// of this test's tmp dir. See engine-sessions.test.ts for the same pattern.
const { createSession, updateSession, getSession } = await import("../registry.js");

describe("session task-model round-trip", () => {
  it("defaults role=task/kind=execution and persists brief/lifecycle/outcome", () => {
    const s = createSession({ engine: "claude", source: "web", sourceRef: "web:t1", brief: "Add a watchdog" });
    expect(s.sessionRole).toBe("task");
    expect(s.taskKind).toBe("execution");
    expect(s.brief).toBe("Add a watchdog");
    expect(s.lifecycleState).toBeNull();

    updateSession(s.id, { lifecycleState: "archived", outcome: "done, 3 files" });
    const reloaded = getSession(s.id)!;
    expect(reloaded.lifecycleState).toBe("archived");
    expect(reloaded.outcome).toBe("done, 3 files");
  });

  it("can create a home role", () => {
    const s = createSession({ engine: "claude", source: "web", sourceRef: "web:home1", employee: "firmware-lead", sessionRole: "home" });
    expect(s.sessionRole).toBe("home");
  });
});
