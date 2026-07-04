// The restriction-knob demonstration (ADR-0014 acceptance #3, "可拧性"): run the
// SAME sandboxed facet under a permissive profile and under each knob turned on,
// and show that the facet keeps running while the narrowed capability returns a
// refused result — never a withdrawn method. This is the mechanical guarantee
// that confinement is additive: an extension written against the full surface is
// not re-adapted when a restriction is enabled.
//
// The knobs are OS-level (a Seatbelt rule on macOS, a bwrap namespace/bind on
// Linux). The write knob narrows the same way on both. The network knob narrows
// DIFFERENTLY, so the demo asserts the platform-relevant observable:
//   - macOS Seatbelt `(deny network*)` refuses every socket, so a loopback
//     round-trip is refused.
//   - Linux `--unshare-net` puts the guest in a private network namespace with a
//     working loopback but no external interface, so loopback still succeeds and
//     external egress is gone — the absence of an external interface is the
//     narrowing. (This is why a loopback-only probe would miss it on Linux.)
// Run under the TS resolver hook:
//   node --import ./ts-resolve.mjs run-knobs.ts
import { platform } from 'node:os';
import { join } from 'node:path';

import { launchSandboxedGuest } from '../kungfu-guest.js';
import { type SandboxProfile } from '../sandbox-launcher.js';
import { buildFixtureCaps } from './fixture-caps';

const DIR = import.meta.dirname;
const RESOLVER = join(DIR, 'ts-resolve.mjs');
const NODE_CHILD = join(DIR, 'node-child.mjs');
const FACET = join(DIR, 'facet-knobs.mjs');

// The network knob's narrowing shows up in a different observable per platform.
const NET_FIELD = platform() === 'darwin' ? 'loopback' : 'externalNet';

type KnobCase = {
  label: string;
  profile: SandboxProfile;
  expectFs: 'ok' | 'refused';
  expectNet: 'ok' | 'refused';
};

const CASES: KnobCase[] = [
  {
    label: 'permissive (no knob)',
    profile: { base: 'permissive' },
    expectFs: 'ok',
    expectNet: 'ok',
  },
  {
    label: 'knob: denyWrite',
    profile: { base: 'permissive', denyWrite: true },
    expectFs: 'refused',
    expectNet: 'ok',
  },
  {
    label: 'knob: denyNetwork',
    profile: { base: 'permissive', denyNetwork: true },
    expectFs: 'ok',
    expectNet: 'refused',
  },
];

async function runCase(
  profile: SandboxProfile,
): Promise<Record<string, unknown> | null> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    runtime: {
      command: process.execPath,
      args: ['--import', RESOLVER, NODE_CHILD],
      env: { KFX_DECLARED: JSON.stringify(declared), KFX_FACET: FACET },
    },
    caps,
    declared,
    profile,
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`facet child exited ${code}`);
  return readReport();
}

function outcome(value: unknown): 'ok' | 'refused' {
  return String(value).startsWith('refused') ? 'refused' : 'ok';
}

async function main() {
  console.log(
    `\nkfx restriction-knob demo — platform: ${platform()} (network observable: ${NET_FIELD})\n`,
  );
  console.log('  profile                 fs write     network      verdict');
  console.log('  ' + '-'.repeat(58));
  let failed = 0;
  for (const c of CASES) {
    let fs = '—';
    let netv = '—';
    let verdict = 'PASS';
    try {
      const report = await runCase(c.profile);
      fs = String(report?.fsWrite ?? '—');
      netv = String(report?.[NET_FIELD] ?? '—');
      const okFacet = report !== null; // the facet still ran and reported
      const fsMatch = outcome(fs) === c.expectFs;
      const netMatch = outcome(netv) === c.expectNet;
      if (!okFacet || !fsMatch || !netMatch) {
        verdict = `FAIL(fs=${outcome(fs)} net=${outcome(netv)})`;
        failed += 1;
      }
    } catch (e) {
      verdict = `FAIL: ${(e as Error).message}`;
      failed += 1;
    }
    console.log(
      `  ${c.label.padEnd(22)}  ${fs.padEnd(11)}  ${netv.padEnd(11)}  ${verdict}`,
    );
  }
  console.log('  ' + '-'.repeat(58));
  console.log(
    `\n  same facet source in every row: a knob narrows what a capability` +
      ` reaches (a refused syscall / a removed interface), never removes a` +
      ` method — the facet is not re-adapted.`,
  );
  console.log(
    `\n  ${failed === 0 ? 'KNOB DEMO GREEN' : `${failed} CASE(S) FAILED`}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
