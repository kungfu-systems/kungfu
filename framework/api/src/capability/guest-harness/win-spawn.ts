// Harness helper: on Windows, build the AppContainer launcher kungfu-guest needs
// by loading the injected libkungfu binding (path via KFX_KUNGFU_BINDING — the
// built kungfu .node addon). Off-Windows returns undefined so the unix paths are
// untouched. This mirrors how a real host injects the binding (ADR-0011): the
// harness is the host here, so it does the injection.
import { createRequire } from 'node:module';

import { createLibkungfuWindowsSpawn } from '../guest-windows';
import type { WindowsSandboxSpawn } from '../kungfu-guest';

export function harnessWindowsSpawn(): WindowsSandboxSpawn | undefined {
  if (process.platform !== 'win32') {
    return undefined;
  }
  const bindingPath = process.env.KFX_KUNGFU_BINDING;
  if (!bindingPath) {
    throw new Error(
      'KFX_KUNGFU_BINDING must point at the built kungfu .node addon on Windows',
    );
  }
  const require = createRequire(import.meta.url);
  const binding = require(bindingPath);
  return createLibkungfuWindowsSpawn(binding);
}
