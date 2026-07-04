// The guest-host harness: prove the ADR-0014 execution contract on the current
// platform. It runs the SAME facet source per language across both trust tiers
// and checks that a facet never branches on the tier while the transport
// property is exactly as designed — the trusted co-resident tier returns a
// 64-bit genTime by reference (a native bigint / Python int), the sandbox tier
// returns the serialized decimal-string copy.
//
// Cells (one platform's contribution to the {js,py} × {mac, linux} matrix):
//   js  trusted   in-process async caps, zero-copy by reference     → bigint
//   js  sandbox   OS-sandboxed Node child over the stdio relay       → string
//   py  trusted   in-process Python caps, co-resident by reference   → int
//   py  sandbox   OS-sandboxed Python child over the stdio relay      → str
//
// Run it under the TS resolver hook so the capability SDK source loads unchanged:
//   node --import ./ts-resolve.mjs run.ts
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createInProcessAsyncCaps,
  launchSandboxedGuest,
} from '../kungfu-guest';
import { buildFixtureCaps } from './fixture-caps';
import { harnessWindowsSpawn } from './win-spawn';

const DIR = import.meta.dirname;
const RESOLVER = join(DIR, 'ts-resolve.mjs');
const NODE_CHILD = join(DIR, 'node-child.mjs');
const PY_CHILD = join(DIR, 'py-child.py');
const PY_TRUSTED = join(DIR, 'py_trusted.py');
const FACET_JS = join(DIR, 'facet.mjs');
const FACET_PY = join(DIR, 'facet.py');
const CORE_PYTHON = resolve(DIR, '../../../../core/src/python');

type Report = Record<string, unknown> | null;

type Cell = {
  name: string;
  facet: 'js' | 'py';
  tier: 'trusted' | 'sandbox';
  expectType: string;
  run: () => Promise<Report>;
};

async function jsTrusted(): Promise<Report> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const asyncCaps = createInProcessAsyncCaps(caps, declared);
  const facet = await import(pathToFileURL(FACET_JS).href);
  await facet.run(asyncCaps);
  return readReport();
}

async function jsSandbox(): Promise<Report> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    runtime: {
      command: process.execPath,
      args: ['--import', RESOLVER, NODE_CHILD],
      env: { KFX_DECLARED: JSON.stringify(declared), KFX_FACET: FACET_JS },
    },
    caps,
    declared,
    profile: { base: 'permissive' },
    windowsSpawn: harnessWindowsSpawn(),
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`node child exited with code ${code}`);
  return readReport();
}

function pyTrusted(): Promise<Report> {
  const out = spawnSync('python3', [PY_TRUSTED], {
    encoding: 'utf8',
    env: { ...process.env, KFX_FACET: FACET_PY },
  });
  if (out.status !== 0) {
    throw new Error(`py trusted exited ${out.status}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout.trim());
}

async function pySandbox(): Promise<Report> {
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    runtime: {
      command: 'python3',
      args: [PY_CHILD],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_FACET: FACET_PY,
        PYTHONPATH: CORE_PYTHON,
      },
    },
    caps,
    declared,
    profile: { base: 'permissive' },
    windowsSpawn: harnessWindowsSpawn(),
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`python child exited with code ${code}`);
  return readReport();
}

const CELLS: Cell[] = [
  {
    name: 'js  · trusted',
    facet: 'js',
    tier: 'trusted',
    expectType: 'bigint',
    run: jsTrusted,
  },
  {
    name: 'js  · sandbox',
    facet: 'js',
    tier: 'sandbox',
    expectType: 'string',
    run: jsSandbox,
  },
  {
    name: 'py  · trusted',
    facet: 'py',
    tier: 'trusted',
    expectType: 'int',
    run: () => Promise.resolve(pyTrusted()),
  },
  {
    name: 'py  · sandbox',
    facet: 'py',
    tier: 'sandbox',
    expectType: 'str',
    run: pySandbox,
  },
];

function check(report: Report, expectType: string): string | null {
  if (!report) return 'no report delivered';
  if (report.recordCount !== 3) return `recordCount ${report.recordCount} != 3`;
  if (report.joined !== false) return `joined ${report.joined} != false`;
  if (report.genTimeType !== expectType) {
    return `genTimeType '${report.genTimeType}' != '${expectType}'`;
  }
  const first = String(report.firstGenTime);
  if (first !== '1700000000000000001')
    return `firstGenTime ${first} unexpected`;
  return null;
}

async function main() {
  const os = platform();
  console.log(`\nkfx guest-host contract harness — platform: ${os}\n`);
  console.log('  cell            tier      genTime type   result');
  console.log('  ' + '-'.repeat(52));
  let failed = 0;
  for (const cell of CELLS) {
    let report: Report = null;
    let error: string | null = null;
    try {
      report = await cell.run();
      error = check(report, cell.expectType);
    } catch (e) {
      error = (e as Error).message;
    }
    const got = report?.genTimeType ?? '—';
    const status = error ? `FAIL: ${error}` : 'PASS';
    if (error) failed += 1;
    console.log(
      `  ${cell.name.padEnd(14)}  ${cell.tier.padEnd(8)}  ${String(got).padEnd(13)}  ${status}`,
    );
  }
  console.log('  ' + '-'.repeat(52));
  console.log(
    `\n  zero-copy proof: trusted returns genTime by reference (native ` +
      `bigint / int); sandbox returns the serialized string copy over the relay.`,
  );
  console.log(
    `\n  ${failed === 0 ? 'ALL CELLS GREEN' : `${failed} CELL(S) FAILED`}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
