// The default-tier isolation base (ADR-0013): launch an untrusted guest inside an
// OS sandbox so its only egress is the capability relay carried on its stdio
// (framework/api/src/capability/subprocess.ts). Filesystem writes and the network
// are denied by default; reads are allowed, because an interpreter must read its
// own runtime — the read boundary is coarse, which the ADR records as residual
// risk, not an absolute guarantee.
//
// macOS confines the child with a Seatbelt profile via `sandbox-exec`. Linux
// confines it with bubblewrap (`bwrap`): a read-only root, unshared network, and
// its own user/pid/mount namespaces — the practical, unprivileged sandbox on
// current distributions, where raw namespaces are blocked (e.g. Ubuntu's
// AppArmor unprivileged-userns restriction) but bwrap is permitted. If bwrap is
// absent the launch is refused rather than run unconfined: a sandbox that
// silently does nothing is worse than an explicit, visible gap.
import { existsSync } from 'node:fs';
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

// bubblewrap: a read-only view of the whole filesystem (reads work, every write
// is denied), no network (--unshare-all includes the network namespace), its own
// user/pid/mount namespaces, and death with the parent. Inherited stdio is
// untouched, so the capability relay still flows.
const LINUX_BWRAP_ARGS = [
  '--unshare-all',
  '--ro-bind',
  '/',
  '/',
  '--proc',
  '/proc',
  '--dev',
  '/dev',
  '--die-with-parent',
];

const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];

function hasBwrap(): boolean {
  return BWRAP_PATHS.some((p) => existsSync(p));
}

export type SandboxedCommand = { command: string; args: string[] };

export function isOsSandboxSupported(): boolean {
  switch (platform()) {
    case 'darwin':
      return true;
    case 'linux':
      return hasBwrap();
    default:
      return false;
  }
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
      if (!hasBwrap()) {
        throw new Error(
          'os sandbox on linux requires bubblewrap (bwrap); ' +
            'refusing to launch an untrusted guest unconfined',
        );
      }
      return {
        command: 'bwrap',
        args: [...LINUX_BWRAP_ARGS, command, ...args],
      };
    default:
      throw new Error(
        `os sandbox not available on ${platform()}; ` +
          'refusing to launch an untrusted guest unconfined',
      );
  }
}
