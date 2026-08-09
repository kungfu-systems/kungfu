// SPDX-License-Identifier: Apache-2.0
// Gate: the default-tier OS sandbox (KF-ADR-019f86da-4f90-79f1-8716-aca36b142847). A guest launched under the OS
// sandbox reaches out only through the capability relay on its stdio — the
// filesystem and the network are denied. This composes the three pieces: the
// launcher (sandbox-launcher.ts), the transport (subprocess.ts), and the host
// (sandbox.ts). Headless, macOS only (Seatbelt); run.sh skips elsewhere.
import { execSync, spawn } from 'node:child_process';

import { createCapabilityHost } from '../../../framework/api/src/capability/sandbox.ts';
import {
  isOsSandboxSupported,
  osSandboxCommand,
} from '../../../framework/api/src/capability/sandbox-launcher.ts';
import { serveSubprocessCapabilities } from '../../../framework/api/src/capability/subprocess.ts';

if (!isOsSandboxSupported()) {
  console.error('skipped: no os sandbox on this platform (macOS Seatbelt / Linux bwrap)');
  process.exit(0);
}

const python = execSync('command -v python3').toString().trim();
const childScript = new URL('./child.py', import.meta.url).pathname;
const { command, args } = osSandboxCommand(python, [childScript]);

const caps = { rewind: { runs: () => ['run-A', 'run-B'] } };
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'], // stdin/stdout = relay channel; stderr = child's report
});
serveSubprocessCapabilities(child, (emit) =>
  createCapabilityHost(caps, ['rewind'], emit),
);
child.once('exit', (code) => process.exit(code ?? 1));
