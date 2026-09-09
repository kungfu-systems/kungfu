// SPDX-License-Identifier: Apache-2.0
// Gate: a sandboxed Python child reaches only its declared capabilities over the
// subprocess capability transport (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847) — the CLI-plane sibling of the GUI
// Electron IPC transport, same sandbox.ts core, different channel. Headless: a
// Node host holding mock caps + a Python guest (child.py), no Electron. The
// child asserts the roundtrip, an undeclared-capability absence, and a bridged
// subscription; its exit code is this gate's result. Requires node >= 22 (native
// TS type-stripping) and python3.
import { spawn } from 'node:child_process';

import { createCapabilityHost } from '@kungfu-tech/api/capability/sandbox';
import { serveSubprocessCapabilities } from '@kungfu-tech/api/capability/subprocess';

const caps = {
  rewind: { runs: () => ['run-A', 'run-B'] },
  ledger: {
    subscribe: (cb) => {
      // fire two events shortly after the subscribe call returns
      const timer = setTimeout(() => {
        cb(7);
        cb(9);
      }, 10);
      return { stop: () => clearTimeout(timer) };
    },
  },
};

const child = spawn('python3', [new URL('./child.py', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'], // stdin/stdout = protocol channel; stderr = child's report
});
serveSubprocessCapabilities(child, (emit) =>
  createCapabilityHost(caps, ['rewind', 'ledger'], emit),
);
child.once('exit', (code) => process.exit(code ?? 1));
