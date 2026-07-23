// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_CATALOG = path.join(
  ROOT,
  'framework',
  'core',
  'src',
  'python',
  'kungfu',
  'agent',
  'cli_surface.catalog.json',
);

const PROFILE_BRIEF = {
  schema: 'kungfu.profile-brief/v1',
  id: 'qualification.cli-installed-product',
  title: 'CLI Installed Product Qualification',
  version: '1.0.0',
  purposes: ['installed-product-qualification'],
  permissions: [],
  identity: { authority: 'workspace-owner' },
  evidence: { strength: 'reported-with-references' },
  migration: { mode: 'additive' },
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function semanticRoot(value) {
  const bytes = JSON.stringify(stable(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function defaultRun({ cli, args, env, cwd }) {
  const result = spawnSync(cli, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    signal: result.signal,
  };
}

function successful(result, label) {
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status ?? `signal ${result.signal}`}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function rootsFrom(catalog) {
  return {
    catalogRoot: catalog.catalogRoot,
    surfaceRoot: catalog.surfaceRoot,
    contractRoot: catalog.contractRoot,
    registryRoot: catalog.registryRoot,
  };
}

function assertRoots(actual, expected, label) {
  for (const [name, root] of Object.entries(expected)) {
    assert(
      actual[name] === root,
      `${label} ${name} mismatch: expected ${root}, got ${actual[name]}`,
    );
  }
}

function commandRunner({ cli, home, workspace, env, runCommand }) {
  const baseEnv = {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KF_CONFIG_HOME: path.join(home, '.config', 'kungfu'),
    PATH: '/usr/bin:/bin',
  };
  return (args, label, options = {}) => {
    const withHome =
      options.withHome === false ? args : ['--home', home, ...args];
    return successful(
      runCommand({ cli, args: withHome, env: baseEnv, cwd: workspace }),
      label,
    );
  };
}

export function qualifyCliSurface({
  cli,
  expectedCatalog,
  label = 'installed-product',
  identity = {},
  environment = {},
  runCommand = defaultRun,
}) {
  assert(cli, 'CLI path is required');
  assert(
    expectedCatalog?.schema === 'kungfu.cli-surface-catalog/v1',
    'expected CLI surface catalog is invalid',
  );
  const expectedRoots = rootsFrom(expectedCatalog);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cli-surface-qualification-'),
  );
  const home = path.join(tempRoot, 'home');
  const workspace = path.join(tempRoot, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const run = commandRunner({
    cli,
    home,
    workspace,
    env: environment,
    runCommand,
  });

  try {
    const version = run(['--version'], 'kungfu --version', {
      withHome: false,
    }).stdout.trim();
    const defaultHelp = run(['--help'], 'kungfu --help', {
      withHome: false,
    }).stdout;
    const fullHelp = run(['--help-all'], 'kungfu --help-all', {
      withHome: false,
    }).stdout;
    const helpJson = parseJson(
      run(['--help-json'], 'kungfu --help-json', { withHome: false }).stdout,
      'kungfu --help-json',
    );
    const capabilities = parseJson(
      run(['agent', 'capabilities', '--json'], 'kungfu agent capabilities')
        .stdout,
      'kungfu agent capabilities',
    );
    const observedCatalog = capabilities.cliSurface;
    assert(
      observedCatalog?.schema === 'kungfu.cli-surface-catalog/v1',
      'Agent capabilities omitted the complete CLI surface catalog',
    );
    assertRoots(rootsFrom(observedCatalog), expectedRoots, 'installed catalog');
    assert(
      helpJson.schema === 'kungfu.cli-help-projection/v1',
      `unexpected help projection schema: ${helpJson.schema}`,
    );
    assert(
      helpJson.contractRoot === expectedRoots.contractRoot &&
        helpJson.registryRoot === expectedRoots.registryRoot,
      'human help roots do not match the Agent catalog',
    );
    for (const section of ['START HERE', 'ACTION MODEL', 'FACTS & PROOF']) {
      assert(defaultHelp.includes(section), `default help omitted ${section}`);
    }
    for (const section of ['SYSTEM & MAINTENANCE', 'DEVELOPER']) {
      assert(fullHelp.includes(section), `full help omitted ${section}`);
    }

    const surfaces = observedCatalog.surfaces || [];
    const canonicalPaths = new Set(surfaces.map((row) => row.canonical_path));
    const sdkSurface = surfaces.find(
      (row) => row.canonical_path === 'kungfu dev sdk',
    );
    assert(sdkSurface?.aliases?.includes('kungfu sdk'), 'SDK alias is missing');
    assert(
      !canonicalPaths.has('kungfu sdk'),
      'legacy SDK path remained canonical',
    );
    const legacySdk = run(['sdk', '--help'], 'kungfu sdk --help');
    const canonicalSdk = run(['dev', 'sdk', '--help'], 'kungfu dev sdk --help');
    assert(
      !legacySdk.stdout.includes('compatibility alias') &&
        legacySdk.stderr.includes('use `kungfu dev sdk`'),
      'legacy SDK warning did not stay on stderr',
    );
    assert(
      !canonicalSdk.stderr.includes('compatibility alias'),
      'canonical SDK path emitted a compatibility warning',
    );

    const linkage = observedCatalog.kfd3Linkage || [];
    const linkedIds = new Set(
      linkage
        .filter((row) => row.state === 'linked')
        .flatMap((row) => row.apiIds || []),
    );
    assert(linkedIds.has('kungfu.agent.brief'), 'KFD-3 omitted agent brief');
    assert(
      linkedIds.has('kungfu.agent.capabilities'),
      'KFD-3 omitted Agent capabilities',
    );

    const profileCapabilities = parseJson(
      run(['profile', 'capabilities', '--json'], 'kungfu profile capabilities')
        .stdout,
      'kungfu profile capabilities',
    );
    const kfxList = parseJson(
      run(['kfx', 'list', '--json'], 'kungfu kfx list').stdout,
      'kungfu kfx list',
    );
    assert(
      Array.isArray(kfxList),
      'fresh-install KFX inventory is not a JSON list',
    );
    const profileKfxCount = surfaces.filter(
      (row) => row.owner === 'profile-kfx',
    ).length;
    assert(profileKfxCount > 0, 'catalog omitted Profile KFX contributions');

    const brief = run(['agent', 'brief'], 'kungfu agent brief').stdout;
    assert(
      brief.includes('kungfu xinfa compile'),
      'offline Agent brief omitted the single-entry topology',
    );

    const briefPath = path.join(tempRoot, 'profile-brief.json');
    const profileSource = path.join(tempRoot, 'profile-source');
    fs.writeFileSync(briefPath, `${JSON.stringify(PROFILE_BRIEF, null, 2)}\n`);
    const planArgs = [
      'profile',
      'scaffold',
      briefPath,
      '--out',
      profileSource,
      '--json',
    ];
    const firstPlan = parseJson(
      run(planArgs, 'Profile scaffold plan').stdout,
      'Profile scaffold plan',
    );
    const secondPlan = parseJson(
      run(planArgs, 'Profile scaffold replay').stdout,
      'Profile scaffold replay',
    );
    assert(
      firstPlan.schema === 'kungfu.profile-source-plan/v1' && firstPlan.ok,
      'Profile scaffold did not return a ready plan',
    );
    assert(
      firstPlan.planId === secondPlan.planId,
      'Profile scaffold plan is not idempotent',
    );
    const receipt = parseJson(
      run(
        [...planArgs.slice(0, -1), '--execute', '--json'],
        'Profile scaffold execute',
      ).stdout,
      'Profile scaffold execute',
    );
    assert(
      receipt.schema === 'kungfu.profile-source-receipt/v1' && receipt.verified,
      'Profile scaffold receipt did not verify',
    );
    assert(
      receipt.planId === firstPlan.planId,
      'Profile receipt does not bind the reviewed plan',
    );

    const ownerCounts = Object.fromEntries(
      [...new Set(surfaces.map((row) => row.owner))]
        .sort()
        .map((owner) => [
          owner,
          surfaces.filter((row) => row.owner === owner).length,
        ]),
    );
    const availabilityCounts = Object.fromEntries(
      [...new Set(surfaces.map((row) => row.availability?.state || 'unknown'))]
        .sort()
        .map((state) => [
          state,
          surfaces.filter(
            (row) => (row.availability?.state || 'unknown') === state,
          ).length,
        ]),
    );
    const result = {
      schema: 'kungfu.cli-installed-product-qualification/v1',
      qualified: true,
      label,
      identity,
      platform: `${process.platform}-${process.arch}`,
      version,
      roots: expectedRoots,
      inventory: {
        surfaceCount: surfaces.length,
        aliasCount: surfaces.reduce(
          (sum, row) => sum + (row.aliases || []).length,
          0,
        ),
        kfd3LinkedCount: linkage.filter((row) => row.state === 'linked').length,
        ownerCounts,
        availabilityCounts,
      },
      checks: {
        progressiveHelp: {
          schema: helpJson.schema,
          projectionRoot: helpJson.projectionRoot,
          defaultDigest: digest(defaultHelp),
          fullDigest: digest(fullHelp),
        },
        agentCatalog: {
          schema: observedCatalog.schema,
          commandPackSchema: capabilities.commands?.schema,
        },
        canonicalAlias: {
          canonical: 'kungfu dev sdk',
          legacy: 'kungfu sdk',
          warningChannel: 'stderr',
        },
        kfd3: { linkedApiCount: linkedIds.size },
        profileKfx: {
          capabilitySchema: profileCapabilities.schema,
          profileKfxCount,
          freshHomeInstalledCount: kfxList.length,
        },
        offlineBrief: { digest: digest(brief) },
        mutationPlanReceipt: {
          planSchema: firstPlan.schema,
          receiptSchema: receipt.schema,
          planReplayStable: true,
          receiptVerified: true,
        },
      },
      isolation: {
        temporaryHome: true,
        temporaryWorkspace: true,
        pathNodeAvailable: false,
        sourceCheckoutRequired: false,
        guiPrivateStateRequired: false,
      },
      nonClaims: [
        'Linux is not qualified by this receipt.',
        'Windows is not qualified by this receipt.',
        'Availability metadata does not activate a KFX contribution.',
      ],
    };
    result.qualificationRoot = semanticRoot(result);
    return result;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (
      !['--cli', '--catalog', '--label', '--build-info', '--retain'].includes(
        arg,
      )
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replaceAll('-', '_')] = argv[index];
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  if (!options.cli) throw new Error('--cli is required');
  const catalog = readJson(options.catalog || DEFAULT_CATALOG, 'catalog');
  const identity = options.build_info
    ? readJson(options.build_info, 'build info')
    : {};
  const result = qualifyCliSurface({
    cli: path.resolve(options.cli),
    expectedCatalog: catalog,
    label: options.label,
    identity,
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.retain) {
    fs.mkdirSync(path.dirname(path.resolve(options.retain)), {
      recursive: true,
    });
    fs.writeFileSync(path.resolve(options.retain), text);
  }
  process.stdout.write(text);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[cli-surface-qualification] ${error.message}\n`);
    process.exitCode = 1;
  }
}
