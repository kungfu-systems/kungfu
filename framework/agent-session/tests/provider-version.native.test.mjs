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
  test(`${provider} version metadata never gates the adapter or reads private state`, (t) => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), `kungfu-${provider}-version-`),
    );
    t.after(() => fs.rmSync(home, { force: true, recursive: true }));
    const result = probeProviderVersion({
      provider,
      executable: process.env[variable] ?? fallback,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LANG: 'C',
        LC_ALL: 'C',
      },
    });
    assert.equal(result.compatible, true);
    assert.equal(result.tested, true);
    assert.equal(result.versionAdmission, 'diagnostic-only');
    assert.equal(result.inspectedPrivateState, false);
    if (result.warning?.includes('ENOENT')) {
      t.skip(`${provider} CLI is not installed`);
    }
  });
}
