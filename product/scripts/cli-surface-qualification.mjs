// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSpecification } from '../../scripts/libwasm-command.mjs';

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
const PRODUCT_SIGNATURE = 'Kungfu UNGFU™';
const PRODUCT_PRINCIPLE = 'Never Guess. Facts Unfold.';
const QUALIFIED_CLI_PLATFORMS = [
  'darwin-arm64',
  'linux-arm64',
  'linux-x64',
  'windows-x64',
];
const QUALIFIED_CLI_SYSTEMS = [
  { id: 'darwin', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
];
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

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

export function cliQualificationRoot(value) {
  const bytes = JSON.stringify(stable(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function cliQualificationPlatform(
  platform = process.platform,
  architecture = process.arch,
) {
  const publicPlatform = platform === 'win32' ? 'windows' : platform;
  return `${publicPlatform}-${architecture}`;
}

export function cliQualificationNonClaims(qualifiedPlatform) {
  assert(
    QUALIFIED_CLI_PLATFORMS.includes(qualifiedPlatform),
    `unsupported CLI qualification platform: ${qualifiedPlatform}`,
  );
  const qualifiedSystem = qualifiedPlatform.split('-')[0];
  return [
    ...QUALIFIED_CLI_SYSTEMS.filter(({ id }) => id !== qualifiedSystem).map(
      ({ label }) => `${label} is not qualified by this receipt.`,
    ),
    'Availability metadata does not activate a KFX contribution.',
  ];
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

export function cliSpawnSpecification(
  cli,
  args,
  platform = process.platform,
  env = process.env,
) {
  return spawnSpecification(cli, args, platform, env);
}

function defaultRun({ cli, args, env, cwd }) {
  const specification = cliSpawnSpecification(cli, args, process.platform, env);
  const result = spawnSync(specification.command, specification.args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(specification.shell ? { shell: specification.shell } : {}),
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

function normalizeHelpPresentation(value) {
  return String(value)
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .join('\n')
    .trim();
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
  if (label === 'cli-archive') {
    assert(identity.archive, 'CLI archive qualification omitted its filename');
    assert(
      SHA256_PATTERN.test(identity.archiveSha256 || ''),
      'CLI archive qualification omitted its SHA-256 digest',
    );
    assert(
      SHA1_PATTERN.test(identity.sourceCommit || ''),
      'CLI archive qualification omitted its exact source commit',
    );
  }
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
    const versionOutput = run(['--version'], 'kungfu --version', {
      withHome: false,
    }).stdout;
    const versionLines = versionOutput
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const version = versionLines[0] || '';
    assert(
      version.length > 0,
      'kungfu --version omitted its version first line',
    );
    assert(
      versionLines.slice(1).join('\n').includes(PRODUCT_SIGNATURE) &&
        versionLines.slice(1).join('\n').includes(PRODUCT_PRINCIPLE),
      'kungfu --version omitted the secondary product signature',
    );
    const defaultHelp = run(['--help'], 'kungfu --help', {
      withHome: false,
    }).stdout;
    const bareHelp = run([], 'bare kungfu', { withHome: false }).stdout;
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
    assert(
      defaultHelp.includes('Project → Work → Agent'),
      'default help omitted the Project, Work, Agent product model',
    );
    assert(
      normalizeHelpPresentation(bareHelp) ===
        normalizeHelpPresentation(defaultHelp),
      'bare kungfu did not match the standalone default help path',
    );
    assert(
      defaultHelp.includes('START HERE'),
      'default help omitted START HERE',
    );
    for (const hiddenSection of ['ACTION MODEL', 'FACTS & PROOF']) {
      assert(
        !defaultHelp.includes(hiddenSection),
        `default help exposed advanced section ${hiddenSection}`,
      );
    }
    for (const section of ['SYSTEM & MAINTENANCE', 'DEVELOPER']) {
      assert(fullHelp.includes(section), `full help omitted ${section}`);
    }

    const surfaces = observedCatalog.surfaces || [];
    const discoverable = surfaces.filter(
      (row) => row.visibility !== 'hidden-internal',
    );
    const canonicalPaths = new Set(
      discoverable.map((row) => row.canonical_path),
    );
    const aliasCount = surfaces.reduce(
      (sum, row) => sum + (row.aliases || []).length,
      0,
    );
    assert(
      aliasCount === 0,
      `installed CLI retained ${aliasCount} compatibility aliases`,
    );
    assert(
      surfaces.every(
        (row) => !['deprecated', 'compatibility'].includes(row.maturity),
      ),
      'installed CLI retained deprecated or compatibility maturity',
    );
    for (const canonical of [
      'kungfu sdk',
      'kungfu env',
      'kungfu dev engage',
      'kungfu dev schema',
      'kungfu work',
    ]) {
      assert(
        canonicalPaths.has(canonical),
        `installed CLI omitted canonical path ${canonical}`,
      );
    }
    for (const removed of [
      'kungfu dev sdk',
      'kungfu dev env',
      'kungfu engage',
      'kungfu schema',
      'kungfu atlas import',
      'kungfu atlas verify',
      'kungfu atlas show',
      'kungfu profile mission-control',
    ]) {
      assert(
        !canonicalPaths.has(removed),
        `installed CLI retained removed path ${removed}`,
      );
    }
    const legacyWorkControlRows = surfaces.filter((row) =>
      String(row.canonical_path || '').startsWith(
        'kungfu profile mission-control',
      ),
    );
    assert(
      legacyWorkControlRows.length > 0 &&
        legacyWorkControlRows.every(
          (row) =>
            row.visibility === 'hidden-internal' &&
            (row.kfd3_api_ids || []).length === 0,
        ),
      'installed v3 compatibility reader is discoverable or owns a KFD identity',
    );
    run(['sdk', '--help'], 'kungfu sdk --help');

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
    const firstValue = parseJson(
      run(
        ['agent', 'first-value', 'contract', '--json'],
        'kungfu agent first-value contract',
      ).stdout,
      'kungfu agent first-value contract',
    );
    assert(
      firstValue.schema === 'kungfu.agent-first-value-contract-view/v1' &&
        firstValue.contract?.result?.maximumQuestionCount === 1 &&
        firstValue.contract?.qualification?.ci ===
          'deterministic-contract-and-receipt-only',
      'installed CLI first-value contract is incomplete',
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
    const qualifiedPlatform = cliQualificationPlatform();
    const result = {
      schema: 'kungfu.cli-installed-product-qualification/v1',
      qualified: true,
      label,
      identity,
      platform: qualifiedPlatform,
      architecture: process.arch,
      version,
      claims: {
        installedProduct: true,
        qualifiedPlatform,
      },
      productIdentity: {
        exactMark: PRODUCT_SIGNATURE,
        principle: PRODUCT_PRINCIPLE,
        renderedVersionOutput: versionLines.join('\n'),
        verifiedFromInstalledCommand: true,
      },
      roots: expectedRoots,
      inventory: {
        surfaceCount: surfaces.length,
        aliasCount,
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
        canonicalOnly: {
          aliases: 0,
          deprecatedMaturity: 0,
          compatibilityMaturity: 0,
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
      nonClaims: cliQualificationNonClaims(qualifiedPlatform),
    };
    result.qualificationRoot = cliQualificationRoot(result);
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
