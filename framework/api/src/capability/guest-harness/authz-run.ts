// Service-authorization vertical cut (ADR-0017 stage 2c): prove the three-layer
// user grant resolves to the right OS-sandbox profile, never pierces the trust
// tier, persists through the ConfigStore, and — closing the loop with stage 2b —
// that the resolved profile actually flips an untrusted service's real network
// egress. A user grant → a SandboxProfile → a genuine change at the membrane.
//
// Part A  pure resolution: three layers, trusted short-circuit, consent flag.
// Part B  persistence: the grant round-trips through a ConfigStore double.
// Part C  integration: the resolved profile drives launchSandboxedGuest and the
//         untrusted child's external egress is refused ungranted, allowed once
//         the network is granted — while the relay flows either way.
//
// Run under the TS resolver hook:
//   node --import ./ts-resolve.mjs authz-run.ts
// Part C needs outbound network for the granted cell (like service-run.ts).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ConfigEntry, DomainState } from '../domain';
import { launchSandboxedGuest } from '../kungfu-guest';
import {
  type ServiceAuthz,
  loadServiceAuthz,
  resolveServiceLanding,
  saveServiceAuthz,
} from '../service-authz';
import { buildFixtureCaps } from './fixture-caps';
import { harnessWindowsSpawn } from './win-spawn';

const DIR = import.meta.dirname;
const RESOLVER = join(DIR, 'ts-resolve.mjs');
const NODE_CHILD = join(DIR, 'node-child.mjs');
const SERVICE_FACET = join(DIR, 'service-facet.mjs');
const NET_URL = process.env.KFX_NET_URL ?? 'https://example.com';
const KEY = 'demo.svc';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
}

// ── Part A: three-layer resolution ───────────────────────────────────────────
function partA(): void {
  console.log('\nA. resolution (three layers, tier boundary, consent):');

  // a trusted service short-circuits to co-resident BEFORE any grant is read.
  ok(
    'trusted → co-resident',
    resolveServiceLanding({}, KEY, true).tier === 'co-resident',
  );
  ok(
    'trusted ignores a network grant (tier not pierceable)',
    resolveServiceLanding({ globalAllow: { network: true } }, KEY, true)
      .tier === 'co-resident',
  );

  // an ungranted untrusted service is fully default-deny.
  const d = resolveServiceLanding({}, KEY, false);
  ok('untrusted default → sandbox', d.tier === 'sandbox');
  if (d.tier === 'sandbox') {
    ok('default denies network', d.profile.denyNetwork === true);
    ok('default denies write', d.profile.denyWrite === true);
    ok('default flags no consent', d.networkConsent === false);
  }

  // layer 2: an operator-wide relaxation opens the network for every service.
  const ga = resolveServiceLanding(
    { globalAllow: { network: true } },
    KEY,
    false,
  );
  if (ga.tier === 'sandbox') {
    ok('globalAllow opens network', ga.profile.denyNetwork === false);
    ok('globalAllow still denies write', ga.profile.denyWrite === true);
    ok('opening network flags consent', ga.networkConsent === true);
  }

  // layer 3: a per-kfx override wins over the global layer, both directions.
  const pk = resolveServiceLanding(
    {
      globalAllow: { network: true },
      perKfx: { [KEY]: { network: false, write: true } },
    },
    KEY,
    false,
  );
  if (pk.tier === 'sandbox') {
    ok(
      'per-kfx override closes network over globalAllow',
      pk.profile.denyNetwork === true,
    );
    ok('per-kfx override opens write', pk.profile.denyWrite === false);
    ok('closed network flags no consent', pk.networkConsent === false);
  }
}

// ── Part B: persistence round-trip through a ConfigStore double ───────────────
function fakeDomain(): DomainState {
  let blob: ConfigEntry | null = null;
  return {
    runtimeDir: '/tmp/kfx-authz-harness',
    configs: () => (blob ? [blob] : []),
    setConfig: (location, value) => {
      blob = { location, value };
      return true;
    },
    removeConfig: () => {
      blob = null;
      return true;
    },
    locations: () => [],
  };
}

function partB(): void {
  console.log('\nB. persistence (same ConfigStore as shell state):');

  const domain = fakeDomain();
  const emptyLanding = resolveServiceLanding(
    loadServiceAuthz(domain),
    KEY,
    false,
  );
  ok(
    'empty store → default-deny landing',
    emptyLanding.tier === 'sandbox' &&
      emptyLanding.profile.denyNetwork === true &&
      emptyLanding.profile.denyWrite === true,
  );

  const authz: ServiceAuthz = {
    globalAllow: { network: true },
    perKfx: { [KEY]: { write: true } },
  };
  saveServiceAuthz(domain, authz);
  const back = loadServiceAuthz(domain);
  ok('globalAllow round-trips', back.globalAllow?.network === true);
  ok('per-kfx grant round-trips', back.perKfx?.[KEY]?.write === true);

  // a resolved landing after reload matches the stored intent.
  const landing = resolveServiceLanding(back, KEY, false);
  ok(
    'reloaded authz resolves network on (global) + write on (per-kfx)',
    landing.tier === 'sandbox' &&
      landing.profile.denyNetwork === false &&
      landing.profile.denyWrite === false,
  );

  // a hostile blob (non-boolean grant fields) is sanitized to default-deny.
  domain.setConfig(
    { category: 'system', group: 'shell', name: 'service-authz', mode: 'live' },
    JSON.stringify({ perKfx: { [KEY]: { network: 'yes', write: 1 } } }),
  );
  const dirty = resolveServiceLanding(loadServiceAuthz(domain), KEY, false);
  ok(
    'non-boolean grant sanitized to default-deny',
    dirty.tier === 'sandbox' && dirty.profile.denyNetwork === true,
  );
}

// ── Part C: resolved profile drives real egress (ties to stage 2b) ────────────
async function egressUnder(authz: ServiceAuthz): Promise<boolean> {
  const landing = resolveServiceLanding(authz, KEY, false);
  if (landing.tier !== 'sandbox') throw new Error('expected a sandbox landing');
  const { caps, declared, readReport } = buildFixtureCaps();
  const guest = await launchSandboxedGuest({
    runtime: {
      command: process.execPath,
      args: ['--import', pathToFileURL(RESOLVER).href, NODE_CHILD],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_FACET: SERVICE_FACET,
        KFX_NET_URL: NET_URL,
      },
    },
    caps,
    declared,
    profile: landing.profile,
    windowsSpawn: harnessWindowsSpawn(),
  });
  const code = await guest.exited;
  if (code !== 0) throw new Error(`service child exited with code ${code}`);
  const r = readReport();
  if (!r || r.relayRecordCount !== 3) {
    throw new Error('relay did not flow under the resolved profile');
  }
  return r.networkOk === true;
}

async function partC(): Promise<void> {
  console.log('\nC. resolved profile → real egress (ties to stage 2b):');
  const denied = await egressUnder({}); // ungranted → default-deny
  ok('ungranted service: external egress refused', denied === false);
  const allowed = await egressUnder({ perKfx: { [KEY]: { network: true } } });
  ok('network-granted service: external egress allowed', allowed === true);
}

async function main(): Promise<void> {
  console.log('kfx service-authz vertical cut (stage 2c)');
  partA();
  partB();
  try {
    await partC();
  } catch (e) {
    ok(`Part C threw: ${(e as Error).message}`, false);
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
