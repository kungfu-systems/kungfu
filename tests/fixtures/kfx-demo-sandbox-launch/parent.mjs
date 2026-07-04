// SPDX-License-Identifier: Apache-2.0
// Gate: the default-tier OS sandbox (ADR-0013). A guest launched under the OS
// sandbox reaches out only through the capability relay on its stdio — the
// filesystem and the network are denied. This composes the three pieces: the
// launcher (sandbox-launcher.ts), the transport (subprocess.ts), and the host
// (sandbox.ts). Headless, macOS only (Seatbelt); run.sh skips elsewhere.
import { execSync, spawn } from 'node:child_process';

import { createCapabilityHost } from '../../../framework/api/src/capability/sandbox.ts';
import { osSandboxCommand } from '../../../framework/api/src/capability/sandbox-launcher.ts';
import { serveSubprocessCapabilities } from '../../../framework/api/src/capability/subprocess.ts';

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
