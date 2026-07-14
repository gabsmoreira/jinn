import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore -- plain .mjs postinstall script, no type declarations
import { fixSpawnHelper } from '../../../scripts/fix-spawn-helper.mjs';

describe('fixSpawnHelper', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-spawn-helper-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds the executable bit to every prebuilds/*/spawn-helper', () => {
    const helpers = [
      path.join(tmp, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      path.join(tmp, 'prebuilds', 'darwin-x64', 'spawn-helper'),
    ];
    for (const h of helpers) {
      fs.mkdirSync(path.dirname(h), { recursive: true });
      fs.writeFileSync(h, 'binary');
      fs.chmodSync(h, 0o644);
      expect(fs.statSync(h).mode & 0o111).toBe(0); // not executable yet
    }

    fixSpawnHelper(tmp);

    for (const h of helpers) {
      expect(fs.statSync(h).mode & 0o111).toBe(0o111); // now executable
    }
  });

  it('does not throw when prebuilds is absent', () => {
    expect(() => fixSpawnHelper(tmp)).not.toThrow();
  });
});
