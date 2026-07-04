// The default-tier isolation base (ADR-0013): launch an untrusted guest inside an
// OS sandbox so its only egress is the capability relay carried on its stdio
// (framework/api/src/capability/subprocess.ts). Filesystem writes and the network
// are denied by default; reads are allowed, because an interpreter must read its
// own runtime — the read boundary is coarse, which the ADR records as residual
// risk, not an absolute guarantee.
//
// macOS confines the child with a Seatbelt profile via `sandbox-exec`. Linux
// (Landlock + seccomp-BPF + user/pid/net namespaces) is not implemented yet and
// is refused rather than run unconfined: a sandbox that silently does nothing is
// worse than an explicit, visible gap.
import { platform } from 'node:os';

// Deny by default; allow exec/fork and reads (the interpreter needs its runtime)
// and the /dev nodes a process needs; deny every filesystem write and all network.
// Inherited stdio (fds 0-2) is unaffected, so the capability relay still flows.
// Seatbelt is last-match-wins, so the /dev write allowances follow the blanket
// write denial.
const MACOS_SEATBELT_PROFILE = [
  '(version 1)',
  '(deny default)',
  '(allow process-fork)',
  '(allow process-exec)',
  '(allow sysctl-read)',
  '(allow file-read*)',
  '(deny file-write*)',
  '(allow file-write-data (literal "/dev/null"))',
  '(allow file-write-data (literal "/dev/dtracehelper"))',
  '(deny network*)',
].join('');

export type SandboxedCommand = { command: string; args: string[] };

export function isOsSandboxSupported(): boolean {
  return platform() === 'darwin';
}

// Wrap a command so it runs inside the OS default-deny sandbox. Throws on a
// platform whose sandbox is not implemented — the caller must not fall back to
// launching the guest unconfined.
export function osSandboxCommand(
  command: string,
  args: readonly string[] = [],
): SandboxedCommand {
  switch (platform()) {
    case 'darwin':
      return {
        command: 'sandbox-exec',
        args: ['-p', MACOS_SEATBELT_PROFILE, command, ...args],
      };
    case 'linux':
      throw new Error(
        'os sandbox not implemented on linux yet (Landlock + seccomp + namespaces); ' +
          'refusing to launch an untrusted guest unconfined',
      );
    default:
      throw new Error(
        `os sandbox not available on ${platform()}; ` +
          'refusing to launch an untrusted guest unconfined',
      );
  }
}
