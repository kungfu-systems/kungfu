#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

const [pluginUrl, runtimeDir] = process.argv.slice(2);
if (!pluginUrl || !runtimeDir) {
  throw new Error('usage: crash-driver.mjs PLUGIN_URL RUNTIME_DIR');
}
const { createKungfuOpenCodePlugin } = await import(pluginUrl);
const hooks = await createKungfuOpenCodePlugin({ runtimeDir })({
  directory: process.cwd(),
  worktree: process.cwd(),
});
await hooks.event({
  event: {
    type: 'session.created',
    properties: { info: { id: 'qualification-long-task' } },
  },
});
await hooks['tool.execute.before'](
  { sessionID: 'qualification-long-task', tool: 'qualification-fixture' },
  { args: { privatePayload: 'must-not-be-retained' } },
);
if (process.platform === 'win32') process.abort();
process.kill(process.pid, 'SIGKILL');
