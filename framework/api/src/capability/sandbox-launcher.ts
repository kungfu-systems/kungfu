// The default-tier isolation base (ADR-0013 / ADR-0014): launch an untrusted
// guest inside an OS sandbox so its only egress is the capability relay carried
// on its stdio (framework/api/src/capability/subprocess.ts).
//
// A profile is composed from a base disposition and independent restriction
// knobs, so the same launcher serves the first delivery's permissive default
// (ADR-0014: run first, restrict later) and each restriction turned on as a
// transparent narrowing rather than a code path of its own:
//
//   - base 'permissive' — reads, writes and the network are all allowed; the
//     guest can run its own runtime and reach the network, confined only by the
//     OS sandbox membrane and its own namespaces. This is the day-one profile
//     the uniform surface is proven against before any restriction is layered on.
//   - base 'restrictive' — writes and the network are denied (reads stay open,
//     an interpreter must read its runtime). This is the isolation ADR-0013
//     describes and the network/filesystem-write denials verified on hardware.
//
// Each knob (`denyNetwork`, `denyWrite`) overrides its base default, so a single
// narrowing — e.g. deny the network on an otherwise permissive guest — is one
// flag, not a separate profile. An extension written against the full capability
// surface keeps running when a knob is turned on; it observes a narrower result
// (a refused socket, a read-only mount), never a withdrawn capability.
//
// macOS confines the child with a Seatbelt profile via `sandbox-exec`. Linux
// confines it with bubblewrap (`bwrap`): its own user/pid/ipc/uts namespaces, a
// bound root (read-only when writes are denied), and the network namespace
// unshared only when the network is denied — the practical, unprivileged sandbox
// on current distributions, where raw namespaces are blocked (e.g. Ubuntu's
// AppArmor unprivileged-userns restriction) but bwrap is permitted. If bwrap is
// absent the launch is refused rather than run unconfined: a sandbox that
// silently does nothing is worse than an explicit, visible gap.
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

// A profile disposition plus the restriction knobs that narrow it. Omitted knobs
// take the base default: a permissive base allows the network and writes; a
// restrictive base denies both. Reads are always allowed — the guest must read
// its own interpreter and runtime; narrowing reads is a follow-up (ADR-0014
// feasibility map: Landlock on Linux, profile read rules on macOS).
export type SandboxProfile = {
  base?: 'permissive' | 'restrictive';
  denyNetwork?: boolean;
  denyWrite?: boolean;
};

type ResolvedProfile = { denyNetwork: boolean; denyWrite: boolean };

function resolveProfile(profile: SandboxProfile = {}): ResolvedProfile {
  const restrictive = profile.base === 'restrictive';
  return {
    denyNetwork: profile.denyNetwork ?? restrictive,
    denyWrite: profile.denyWrite ?? restrictive,
  };
}

// Seatbelt is last-match-wins; the /dev write allowances follow the blanket
// write denial. Inherited stdio (fds 0-2) is unaffected either way, so the
// capability relay still flows.
function macosSeatbeltProfile(resolved: ResolvedProfile): string {
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow sysctl-read)',
    '(allow file-read*)',
  ];
  if (resolved.denyWrite) {
    rules.push('(deny file-write*)');
    rules.push('(allow file-write-data (literal "/dev/null"))');
    rules.push('(allow file-write-data (literal "/dev/dtracehelper"))');
  } else {
    rules.push('(allow file-write*)');
  }
  rules.push(resolved.denyNetwork ? '(deny network*)' : '(allow network*)');
  return rules.join('');
}

// bubblewrap: own user/pid/ipc/uts namespaces; a bound root, read-only when
// writes are denied; the network namespace unshared only when the network is
// denied; death with the parent. Inherited stdio is untouched, so the capability
// relay still flows.
function linuxBwrapArgs(resolved: ResolvedProfile): string[] {
  const args = [
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
  ];
  if (resolved.denyNetwork) args.push('--unshare-net');
  args.push(resolved.denyWrite ? '--ro-bind' : '--bind', '/', '/');
  args.push('--proc', '/proc', '--dev', '/dev', '--die-with-parent');
  return args;
}

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

// Wrap a command so it runs inside the OS sandbox under the given profile. The
// profile defaults to the restrictive disposition (writes and network denied),
// so an unparameterised call keeps ADR-0013's default-deny isolation; a caller
// that wants the ADR-0014 permissive first-delivery profile, or a single knob
// turned on, passes it explicitly. Throws on a platform whose sandbox is not
// implemented — the caller must not fall back to launching the guest unconfined.
export function osSandboxCommand(
  command: string,
  args: readonly string[] = [],
  profile: SandboxProfile = { base: 'restrictive' },
): SandboxedCommand {
  const resolved = resolveProfile(profile);
  switch (platform()) {
    case 'darwin':
      return {
        command: 'sandbox-exec',
        args: ['-p', macosSeatbeltProfile(resolved), command, ...args],
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
        args: [...linuxBwrapArgs(resolved), command, ...args],
      };
    default:
      throw new Error(
        `os sandbox not available on ${platform()}; ` +
          'refusing to launch an untrusted guest unconfined',
      );
  }
}
