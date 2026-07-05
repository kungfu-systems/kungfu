// The service-facet vertical cut (ADR-0017 stage 2b): prove that the ALREADY
// verified runtime-plane primitives compose into a real background service — an
// untrusted, networked child confined by the OS sandbox, reaching the host only
// over the stdio relay. The guest-host contract harness (./run.ts) proved the
// transport property with a one-shot facet; this proves the property the service
// facet's security rests on and the guest-host harness never exercised: the
// sandbox membrane's NETWORK rule, and the relay's independence from it.
//
// The SAME service source (./service-facet.mjs) runs under two profiles, never
// branching on which:
//   net-allowed   permissive               → external egress succeeds, relay flows
//   net-denied    permissive + denyNetwork → external egress is REFUSED, relay STILL flows
//
// The second cell is the load-bearing one: turning the network knob on must cut
// the untrusted service's egress (default-deny, ADR-0013) WITHOUT cutting the
// capability relay, because the relay rides the child's stdio, not the network.
// If both held, the OS sandbox is a real membrane for a networked service and the
// relay is genuinely orthogonal to it — the stage-2b unknown, resolved on real
// hardware rather than asserted.
//
// Run under the TS resolver hook so the capability SDK source loads unchanged:
//   node --import ./ts-resolve.mjs service-run.ts
// Needs outbound network for the net-allowed cell; offline it degrades to a
// reported failure (see notes at the bottom).
import { platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { launchSandboxedGuest } from '../kungfu-guest';
import type { SandboxProfile } from '../sandbox-launcher';
import { buildFixtureCaps } from './fixture-caps';
import { harnessWindowsSpawn } from './win-spawn';

const DIR = import.meta.dirname;
const RESOLVER = join(DIR, 'ts-resolve.mjs');
const NODE_CHILD = join(DIR, 'node-child.mjs');
const SERVICE_FACET = join(DIR, 'service-facet.mjs');
const NET_URL = process.env.KFX_NET_URL ?? 'https://example.com';

type Report = Record<string, unknown> | null;

async function runService(profile: SandboxProfile): Promise<Report> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    runtime: {
      command: process.execPath,
      // --import needs a URL specifier; pathToFileURL keeps it portable.
      args: ['--import', pathToFileURL(RESOLVER).href, NODE_CHILD],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_FACET: SERVICE_FACET,
        KFX_NET_URL: NET_URL,
      },
    },
    caps,
    declared,
    profile,
    windowsSpawn: harnessWindowsSpawn(),
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`service child exited with code ${code}`);
  return readReport();
}

type Cell = {
  name: string;
  profile: SandboxProfile;
  // returns an error string if the report violates the expected property
  check: (r: Report) => string | null;
};

const CELLS: Cell[] = [
  {
    name: 'net-allowed',
    profile: { base: 'permissive' },
    check: (r) => {
      if (!r) return 'no report delivered (relay did not flow)';
      if (r.relayRecordCount !== 3)
        return `relay records ${r.relayRecordCount} != 3`;
      if (r.networkOk !== true)
        return `egress failed under permissive: ${r.netError} (offline?)`;
      return null;
    },
  },
  {
    name: 'net-denied',
    profile: { base: 'permissive', denyNetwork: true },
    check: (r) => {
      if (!r) return 'no report delivered (relay did not flow)';
      // the load-bearing property: relay flows even with the network denied.
      if (r.relayRecordCount !== 3)
        return `relay records ${r.relayRecordCount} != 3 (relay cut with network)`;
      // and egress must be refused, not merely failed by chance.
      if (r.networkOk !== false)
        return 'egress SUCCEEDED under denyNetwork — the membrane did not confine';
      if (!r.netError) return 'egress failed but reported no error';
      return null;
    },
  },
];

async function main() {
  const os = platform();
  console.log(`\nkfx service-facet vertical cut (stage 2b) — platform: ${os}`);
  console.log(`  network target: ${NET_URL}\n`);
  console.log(
    '  cell         profile                    egress   relay   result',
  );
  console.log(`  ${'-'.repeat(62)}`);
  let failed = 0;
  for (const cell of CELLS) {
    let report: Report = null;
    let error: string | null = null;
    try {
      report = await runService(cell.profile);
      error = cell.check(report);
    } catch (e) {
      error = (e as Error).message;
    }
    const egress = report ? (report.networkOk ? 'ok' : 'refused') : '—';
    const relay = report ? String(report.relayRecordCount ?? '—') : '—';
    const status = error ? `FAIL: ${error}` : 'PASS';
    if (error) failed += 1;
    const prof = JSON.stringify(cell.profile);
    console.log(
      `  ${cell.name.padEnd(11)}  ${prof.padEnd(26)}  ${egress.padEnd(7)}  ${relay.padEnd(5)}  ${status}`,
    );
  }
  console.log(`  ${'-'.repeat(62)}`);
  console.log(
    `\n  membrane proof: denyNetwork refuses the untrusted service's external\n` +
      '  egress while the capability relay (stdio) keeps flowing — the OS sandbox\n' +
      '  is a real network membrane and the relay is orthogonal to it.',
  );
  console.log(
    `\n  ${failed === 0 ? 'ALL CELLS GREEN' : `${failed} CELL(S) FAILED`}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
