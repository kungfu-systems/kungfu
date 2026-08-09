import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { probeProviderVersion } from '../src/provider-adapters.mjs';

for (const [provider, variable, fallback] of [
  ['codex', 'KUNGFU_CODEX_BIN', 'codex'],
  ['claude', 'KUNGFU_CLAUDE_BIN', 'claude'],
]) {
  test(`installed ${provider} CLI matches the versioned adapter without private state`, (t) => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), `kungfu-${provider}-version-`),
    );
    t.after(() => fs.rmSync(home, { force: true, recursive: true }));
    let result;
    try {
      result = probeProviderVersion({
        provider,
        executable: process.env[variable] ?? fallback,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          LANG: 'C',
          LC_ALL: 'C',
        },
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        t.skip(`${provider} CLI is not installed`);
        return;
      }
      throw error;
    }
    assert.equal(result.compatible, true);
    assert.equal(result.tested, true);
    assert.equal(result.inspectedPrivateState, false);
  });
}
