import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

vi.mock("../../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

let tmpHome: string
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-syncstate-"))
  process.env.JINN_HOME = tmpHome
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.JINN_HOME
})

describe("sync-state", () => {
  it("returns defaults when missing", async () => {
    const { loadSyncState } = await import("../sync-state.js")
    expect(loadSyncState()).toEqual({
      linkedItemIds: [], deletedItemIds: [], lastPollAt: null, lastError: null,
    })
  })
  it("round-trips", async () => {
    const { loadSyncState, saveSyncState } = await import("../sync-state.js")
    saveSyncState({ linkedItemIds: ["a"], deletedItemIds: ["b"], lastPollAt: 5, lastError: "x" })
    expect(loadSyncState()).toEqual({
      linkedItemIds: ["a"], deletedItemIds: ["b"], lastPollAt: 5, lastError: "x",
    })
  })
})
