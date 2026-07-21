import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import os from "node:os"; import fs from "node:fs"; import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-role-mig-"));
process.env.JINN_HOME = tmp;
import { migrateSessionsSchema } from "../registry.js";

describe("migrateSessionsSchema — task-model columns", () => {
  it("adds session_role/task_kind/lifecycle_state/brief/outcome, defaults legacy rows, idempotent", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, engine TEXT NOT NULL, source TEXT NOT NULL,
      source_ref TEXT NOT NULL, status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL, last_activity TEXT NOT NULL)`);
    db.prepare(`INSERT INTO sessions (id,engine,source,source_ref,status,created_at,last_activity)
      VALUES ('old-1','claude','web','web:old','idle','t','t')`).run();

    migrateSessionsSchema(db);
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(c => c.name);
    for (const c of ["session_role","task_kind","lifecycle_state","brief","outcome"]) expect(cols).toContain(c);

    const row = db.prepare("SELECT session_role,task_kind,lifecycle_state FROM sessions WHERE id='old-1'").get() as any;
    expect(row.session_role).toBe("task");
    expect(row.task_kind).toBe("execution");
    expect(row.lifecycle_state).toBeNull();

    expect(() => migrateSessionsSchema(db)).not.toThrow();
    const roleCols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).filter(c => c.name === "session_role");
    expect(roleCols.length).toBe(1);
  });
});
