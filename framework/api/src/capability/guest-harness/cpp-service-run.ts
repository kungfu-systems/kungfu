// The C++ runtime lane of the service-facet vertical cut (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): prove the
// NEW C++ guest end (framework/core/src/capability/guest.hpp) speaks the same
// capability relay the node/python guests do, from inside the OS sandbox, and
// that the sandbox membrane confines a C++ service exactly as it confines a node
// one. It is the sibling of ./service-run.ts (node); the only difference is the
// runtime the host launches — and that difference is the point.
//
// The node lane launches an interpreter (`node --import <resolver> node-child`)
// that loads a source facet. A C++ service has no interpreter: the SAME source
// (./cpp-service.cpp) is compiled once into a prebuilt binary, and the host
// launches THAT binary directly — `runtime.command = <binary>`, `args = []`, no
// bootstrap. This is the prebuilt-artifact cpp entry KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be resolves, run end
// to end against the real trusted host.
//
// The SAME binary runs under two profiles, never branching on which:
//   net-allowed   permissive               → external egress succeeds, relay flows
//   net-denied    permissive + denyNetwork → external egress is REFUSED, relay STILL flows
//
// Run under the TS resolver hook so the capability SDK source loads unchanged:
//   node --import ./ts-resolve.mjs cpp-service-run.ts
// Needs a C++ toolchain + conan to build the guest binary; where either is
// absent it skips cleanly (a build it cannot perform is not a failed proof).
// Needs outbound network for the net-allowed cell; offline it degrades to a
// reported failure (see notes at the bottom).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchSandboxedGuest } from '../kungfu-guest';
import type { SandboxProfile } from '../sandbox-launcher';
import { buildCppGuest, cppBuildAvailable } from './cpp-build.mjs';
import { buildFixtureCaps } from './fixture-caps';
import { harnessWindowsSpawn } from './win-spawn';

const HERE = import.meta.dirname;
const CPP_SOURCE = join(HERE, 'cpp-service.cpp');
const NET_URL = process.env.KFX_NET_URL ?? 'https://example.com';

type Report = Record<string, unknown> | null;

async function runService(
  binary: string,
  profile: SandboxProfile,
): Promise<Report> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    // the defining difference from the node lane: the command IS the prebuilt
    // C++ service binary; no interpreter, no bootstrap, no argv.
    runtime: {
      command: binary,
      args: [],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_NET_URL: NET_URL,
      },
    },
    caps,
    declared,
    profile,
    windowsSpawn: harnessWindowsSpawn(),
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`cpp service exited with code ${code}`);
  return readReport();
}

type Cell = {
  name: string;
  profile: SandboxProfile;
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
  console.log(
    '\nkfx service-facet vertical cut — C++ runtime lane (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be)',
  );
  console.log(`  network target: ${NET_URL}\n`);

  if (!cppBuildAvailable()) {
    console.log('  (skip: no C++ toolchain or conan on this platform)\n');
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'kfx-cpp-guest-'));
  const binary = join(workdir, 'cpp-service');
  try {
    console.log('  compiling cpp-service.cpp (guest.hpp + nlohmann)…');
    buildCppGuest(CPP_SOURCE, binary);

    console.log(
      '\n  cell         profile                    egress   relay   result',
    );
    console.log(`  ${'-'.repeat(62)}`);
    let failed = 0;
    for (const cell of CELLS) {
      let report: Report = null;
      let error: string | null = null;
      try {
        report = await runService(binary, cell.profile);
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
      '\n  C++ guest proof: a compiled C++ service speaks the capability relay\n' +
        '  (ledger.records over stdio) while the OS sandbox gates its network the\n' +
        '  same way it gates a node service — one protocol, a third runtime.',
    );
    console.log(
      `\n  ${failed === 0 ? 'ALL CELLS GREEN' : `${failed} CELL(S) FAILED`}\n`,
    );
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
