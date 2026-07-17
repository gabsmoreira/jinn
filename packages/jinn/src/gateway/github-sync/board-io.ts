import fs from "node:fs"
import path from "node:path"
import { ORG_DIR } from "../../shared/paths.js"
import { logger } from "../../shared/logger.js"
import type { BoardItem } from "./types.js"

export function boardPathFor(department: string): string {
  return path.join(ORG_DIR, department, "board.json")
}

export function readBoard(department: string): BoardItem[] {
  const boardPath = boardPathFor(department)
  let raw: string
  try {
    raw = fs.readFileSync(boardPath, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`Failed to read board ${boardPath}: ${err instanceof Error ? err.message : err}`)
    }
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BoardItem[]) : []
  } catch (err) {
    const backup = `${boardPath}.corrupt-${Date.now()}`
    try { fs.copyFileSync(boardPath, backup) } catch { /* best effort */ }
    logger.error(`Corrupt board ${boardPath}; backed up to ${backup}, treating as empty.`)
    return []
  }
}

export function writeBoard(department: string, items: BoardItem[]): void {
  const boardPath = boardPathFor(department)
  fs.mkdirSync(path.dirname(boardPath), { recursive: true })
  const tmp = `${boardPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, boardPath)
}
