import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * node-pty ships a `spawn-helper` binary under `prebuilds/<platform>/` that must
 * be executable — on macOS/Linux node-pty launches it via `posix_spawnp` to set
 * up the controlling TTY. Some install paths (notably the published npm tarball)
 * drop the executable bit, so the launch fails with `Error: posix_spawnp failed`
 * and jinn cannot spawn any engine. Restore the bit. Best-effort: never throws,
 * so it can't break `npm install`.
 *
 * @param {string} [nodePtyDir] node-pty package dir; auto-resolved when omitted.
 */
export function fixSpawnHelper(nodePtyDir) {
  try {
    const dir = nodePtyDir ?? resolveNodePtyDir();
    if (!dir) return;
    const prebuilds = path.join(dir, "prebuilds");
    let platforms;
    try {
      platforms = fs.readdirSync(prebuilds);
    } catch {
      return; // no prebuilds dir (e.g. Windows-only conpty layout) — nothing to do
    }
    for (const platform of platforms) {
      const helper = path.join(prebuilds, platform, "spawn-helper");
      try {
        if (fs.statSync(helper).isFile()) fs.chmodSync(helper, 0o755);
      } catch {
        // helper absent on this platform dir, or chmod not permitted — skip it
      }
    }
  } catch {
    // never fail an install over this best-effort fix
  }
}

function resolveNodePtyDir() {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return undefined;
  }
}

// When invoked directly as the postinstall script, run against the real node-pty.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fixSpawnHelper();
}
