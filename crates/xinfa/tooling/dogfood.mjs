#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { consumeXinfaAtlas } from '../../../scripts/kungfu-xinfa-consumer.mjs';

const XINFA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ROOT = path.resolve(XINFA_ROOT, '../..');
const PROJECT_PATH = path.join(ROOT, '.xinfa', 'dogfood-project.json');
const PREFIX = 'xinfa-shifu-kungfu-dogfood-';

/** @param {Buffer|string} value */
function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** @param {unknown} value */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** @param {string} file */
function fileRoot(file) {
  return sha256(fs.readFileSync(file));
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string,env?:NodeJS.ProcessEnv,expected?:number[]}} [options]
 */
function run(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
  });
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const expected = options.expected || [0];
  if (result.error || !expected.includes(result.status ?? -1))
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`,
    );
  return { ...result, elapsedMs };
}

/** @param {ReturnType<typeof run>} result @param {string} label */
function outputJson(result, label) {
  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`${label} did not emit JSON`);
  }
}

/** @param {string} binary @param {string[]} args @param {object} [options] */
function xinfa(binary, args, options = {}) {
  const result = run(binary, [...args, '--json'], options);
  return {
    receipt: outputJson(result, `Xinfa ${args.join(' ')}`),
    elapsedMs: result.elapsedMs,
  };
}

/** @param {string} root */
function readProject(root) {
  return JSON.parse(
    fs.readFileSync(path.join(root, '.xinfa', 'dogfood-project.json'), 'utf8'),
  );
}

/** @param {Record<string, any>} project @param {string} root */
function refreshProjectRoots(project, root) {
  const provider = project.providers[0];
  for (const node of project.nodes)
    node.revision = fileRoot(path.join(root, node.source.path));
  const inventory = provider.paths
    .map((relative) => {
      const file = path.join(root, relative);
      return {
        path: relative,
        contentRoot: fileRoot(file),
        size: fs.statSync(file).size,
      };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  provider.revision = sha256(`${JSON.stringify(stable(inventory))}\n`);
  project.cut.revision = sha256(
    JSON.stringify({
      provider: provider.revision,
      nodes: project.nodes.map((node) => [node.id, node.revision]),
    }),
  );
  return project;
}

/** @param {Record<string, any>} project */
function alignExpectedRevisions(project) {
  const revisions = new Map(
    project.nodes.map((node) => [node.id, node.revision]),
  );
  for (const node of project.nodes)
    for (const dependency of node.verification.dependencies)
      dependency.expectedRevision = revisions.get(dependency.node);
  return project;
}

/** @param {string} target */
function copyDogfoodWorkspace(target) {
  const project = readProject(ROOT);
  for (const relative of project.providers[0].paths) {
    const source = path.join(ROOT, relative);
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.mkdirSync(path.join(target, '.xinfa'), { recursive: true });
  fs.copyFileSync(
    PROJECT_PATH,
    path.join(target, '.xinfa', 'dogfood-project.json'),
  );
}

/** @param {string} root @param {Record<string, any>} project */
function writeProject(root, project) {
  fs.writeFileSync(
    path.join(root, '.xinfa', 'dogfood-project.json'),
    `${JSON.stringify(project, null, 2)}\n`,
  );
}

function resolveCargo() {
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const directories = [
    ...(process.env.SHIFU_ORIGINAL_PATH || '').split(path.delimiter),
    ...(process.env.PATH || '').split(path.delimiter),
    process.env.HOME ? path.join(process.env.HOME, '.cargo', 'bin') : '',
  ].filter(
    (directory, index, values) =>
      directory &&
      !directory.includes('shifu-cache-overlay-') &&
      values.indexOf(directory) === index,
  );
  for (const directory of directories) {
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return {
        binary: candidate,
        originalPath: directories.join(path.delimiter),
      };
    } catch {
      // Continue until a real Cargo binary is found.
    }
  }
  throw new Error('cargo is not available outside the Shifu cache overlay');
}

/** @param {string} binary @param {string} root @param {string} output @param {NodeJS.ProcessEnv} [env] */
function compile(binary, root, output, env = process.env) {
  return xinfa(
    binary,
    [
      'atlas',
      'compile',
      '--project',
      path.join(root, '.xinfa', 'dogfood-project.json'),
      '--output',
      output,
      '--root',
      root,
      '--visibility',
      'public',
    ],
    { cwd: root, env },
  );
}

/** @param {string} target */
function buildStandalone(target) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(XINFA_ROOT, 'extraction-manifest.json'), 'utf8'),
  );
  for (const relative of manifest.files) {
    const source = path.join(XINFA_ROOT, relative);
    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const cargo = resolveCargo();
  const env = {
    ...process.env,
    PATH: cargo.originalPath,
    CARGO_TARGET_DIR: path.join(target, 'target'),
  };
  for (const key of Object.keys(env))
    if (key.startsWith('SHIFU_') || key.startsWith('KUNGFU_')) delete env[key];
  const result = run(
    cargo.binary,
    ['build', '--locked', '--manifest-path', path.join(target, 'Cargo.toml')],
    { cwd: target, env },
  );
  return {
    binary: path.join(
      target,
      'target',
      'debug',
      process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
    ),
    env,
    elapsedMs: result.elapsedMs,
  };
}

/** @param {string} root @param {string} pathName @param {string} suffix */
function mutate(root, pathName, suffix) {
  fs.appendFileSync(path.join(root, pathName), suffix);
  const project = readProject(root);
  refreshProjectRoots(project, root);
  writeProject(root, project);
  return project;
}

function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  try {
    const binary = path.join(
      XINFA_ROOT,
      'tooling',
      process.platform === 'win32' ? 'source-xinfa.cmd' : 'source-xinfa',
    );
    if (!fs.existsSync(binary))
      throw new Error(
        'Xinfa source resolver is missing; run through ./shifu xinfa:dogfood',
      );

    const trackedBefore = run('git', [
      'status',
      '--porcelain=v1',
      '--',
      '.xinfa',
    ]).stdout;
    const proseBefore = fileRoot(
      path.join(ROOT, 'crates', 'xinfa', 'README.md'),
    );
    const trackedProject = readProject(ROOT);
    const expectedProject = alignExpectedRevisions(
      refreshProjectRoots(structuredClone(trackedProject), ROOT),
    );
    if (JSON.stringify(trackedProject) !== JSON.stringify(expectedProject))
      throw new Error(
        'tracked .xinfa/dogfood-project.json revisions do not match the dogfood source cut',
      );

    const directOutput = path.join(temporary, 'direct-atlas');
    const direct = compile(binary, ROOT, directOutput);

    const standaloneRoot = path.join(temporary, 'standalone');
    fs.mkdirSync(standaloneRoot);
    const standaloneBuild = buildStandalone(standaloneRoot);
    const standalone = compile(
      standaloneBuild.binary,
      ROOT,
      path.join(temporary, 'standalone-atlas'),
      standaloneBuild.env,
    );

    const shifuOutput = path.join(temporary, 'shifu-atlas');
    const shifuRun = run(process.execPath, [
      path.join(ROOT, 'shifu.mjs'),
      'docs',
      'xinfa',
      'compile',
      '--project',
      '.xinfa/dogfood-project.json',
      '--root',
      ROOT,
      '--output',
      shifuOutput,
      '--xinfa',
      binary,
      '--json',
    ]);
    const shifu = outputJson(shifuRun, 'Shifu Xinfa adapter');
    const roots = [
      direct.receipt.atlas_root,
      standalone.receipt.atlas_root,
      shifu.xinfa?.compile?.atlas_root,
    ];
    if (new Set(roots).size !== 1)
      throw new Error(
        `standalone/Shifu/direct Atlas roots diverged: ${roots.join(', ')}`,
      );

    const consumerOutput = path.join(temporary, 'kungfu-generated');
    const consumerStarted = performance.now();
    const consumer = consumeXinfaAtlas(
      {
        atlas: directOutput,
        output: consumerOutput,
        xinfa: binary,
        humanRoute: 'kungfu-xinfa-dogfood.human',
        agentRoute: 'kungfu-xinfa-dogfood.agent',
        intent:
          'verify the generated feedback exclusion and shared projection boundary',
        task: 'change and verify the Xinfa Shifu Kungfu adapter boundary',
        role: 'implementer',
        budget: '4096',
        maxHops: '2',
      },
      ROOT,
    );
    const consumerElapsedMs =
      Math.round((performance.now() - consumerStarted) * 100) / 100;

    const driftRoot = path.join(temporary, 'implementation-drift');
    fs.mkdirSync(driftRoot);
    copyDogfoodWorkspace(driftRoot);
    mutate(
      driftRoot,
      'scripts/kungfu-xinfa-consumer.mjs',
      '\n// deliberate implementation drift\n',
    );
    const driftOutput = path.join(temporary, 'drift-atlas');
    const drift = compile(binary, driftRoot, driftOutput);
    const driftHuman = xinfa(binary, [
      'read',
      '--atlas',
      driftOutput,
      '--route',
      'kungfu-xinfa-dogfood.human',
      '--intent',
      'verify shared projection drift',
      '--surface',
      'human',
      '--max-hops',
      '2',
    ]).receipt;
    const driftAgent = xinfa(binary, [
      'context',
      '--atlas',
      driftOutput,
      '--route',
      'kungfu-xinfa-dogfood.agent',
      '--task',
      'change adapter',
      '--role',
      'implementer',
      '--budget',
      '4096',
    ]).receipt;
    const driftImpact = xinfa(binary, [
      'atlas',
      'impact',
      '--since',
      directOutput,
      '--project',
      path.join(driftRoot, '.xinfa', 'dogfood-project.json'),
      '--root',
      driftRoot,
      '--visibility',
      'public',
    ]).receipt;
    if (
      driftHuman.parity.route.status !== 'stale' ||
      driftAgent.parity.route.status !== 'stale' ||
      !driftImpact.impact?.affectedClaims?.includes(
        'kungfu.claim.shared-context',
      )
    )
      throw new Error(
        `implementation drift mismatch: human=${driftHuman.parity.route.status} agent=${driftAgent.parity.route.status} claims=${JSON.stringify(driftImpact.impact?.affectedClaims)}`,
      );

    const narrativeRoot = path.join(temporary, 'non-claim-drift');
    fs.mkdirSync(narrativeRoot);
    copyDogfoodWorkspace(narrativeRoot);
    mutate(narrativeRoot, 'README.md', '\nExpressive dogfood note.\n');
    const narrativeOutput = path.join(temporary, 'non-claim-atlas');
    const narrative = compile(binary, narrativeRoot, narrativeOutput);
    const narrativeImpact = xinfa(binary, [
      'atlas',
      'impact',
      '--since',
      directOutput,
      '--project',
      path.join(narrativeRoot, '.xinfa', 'dogfood-project.json'),
      '--root',
      narrativeRoot,
      '--visibility',
      'public',
    ]).receipt;
    if (narrativeImpact.impact?.affectedClaims?.length !== 0)
      throw new Error(
        'expressive non-claim drift was incorrectly promoted to claim drift',
      );

    const feedbackRoot = path.join(temporary, 'generated-feedback');
    fs.mkdirSync(feedbackRoot);
    copyDogfoodWorkspace(feedbackRoot);
    const generated = path.join(
      feedbackRoot,
      '.xinfa',
      'generated',
      'human.json',
    );
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.copyFileSync(path.join(consumerOutput, 'human.json'), generated);
    const feedbackProject = readProject(feedbackRoot);
    feedbackProject.providers[0].paths.push('.xinfa/generated/human.json');
    feedbackProject.providers[0].paths.sort();
    writeProject(feedbackRoot, feedbackProject);
    const feedbackRun = run(
      binary,
      [
        'atlas',
        'compile',
        '--project',
        path.join(feedbackRoot, '.xinfa', 'dogfood-project.json'),
        '--output',
        path.join(temporary, 'feedback-atlas'),
        '--root',
        feedbackRoot,
        '--visibility',
        'public',
        '--json',
      ],
      { cwd: feedbackRoot, expected: [1] },
    );
    const feedback = outputJson(feedbackRun, 'generated feedback rejection');
    if (
      !feedback.diagnostics?.some(
        (item) => item.code === 'generated-projection-input',
      )
    )
      throw new Error('generated output entered provider closure');

    const acceptedRoot = path.join(temporary, 'explicit-accept');
    fs.mkdirSync(acceptedRoot);
    copyDogfoodWorkspace(acceptedRoot);
    const acceptedPath = 'docs/accepted-xinfa-context.md';
    fs.mkdirSync(path.join(acceptedRoot, 'docs'), { recursive: true });
    fs.copyFileSync(
      path.join(consumerOutput, 'human.md'),
      path.join(acceptedRoot, acceptedPath),
    );
    const acceptedProject = readProject(acceptedRoot);
    acceptedProject.providers[0].paths.push(acceptedPath);
    acceptedProject.providers[0].paths.sort();
    acceptedProject.nodes.push({
      id: 'kungfu.doc.accepted-context',
      kind: 'document',
      visibility: 'public',
      revision: fileRoot(path.join(acceptedRoot, acceptedPath)),
      provenance: { kind: 'project-source', authority: 'kungfu' },
      source: { provider: 'kungfu-xinfa-dogfood.files', path: acceptedPath },
      verification: {
        mode: 'non-claim',
        status: 'non-claim',
        waiver: null,
        dependencies: [],
      },
    });
    for (const route of acceptedProject.routes)
      route.nodes.push('kungfu.doc.accepted-context');
    refreshProjectRoots(acceptedProject, acceptedRoot);
    writeProject(acceptedRoot, acceptedProject);
    const accepted = compile(
      binary,
      acceptedRoot,
      path.join(temporary, 'accepted-atlas'),
    );
    const oldVerify = xinfa(binary, [
      'atlas',
      'verify',
      '--atlas',
      directOutput,
    ]).receipt;
    if (
      accepted.receipt.atlas_root === direct.receipt.atlas_root ||
      oldVerify.valid !== true
    )
      throw new Error(
        'explicit acceptance did not create an immutable successor Atlas',
      );

    const trackedAfter = run('git', [
      'status',
      '--porcelain=v1',
      '--',
      '.xinfa',
    ]).stdout;
    const proseAfter = fileRoot(
      path.join(ROOT, 'crates', 'xinfa', 'README.md'),
    );
    if (trackedAfter !== trackedBefore || proseAfter !== proseBefore)
      throw new Error(
        'ordinary dogfood changed tracked .xinfa state or human-owned prose',
      );

    const receipt = {
      schema: 'xinfa.shifu-kungfu-dogfood-receipt/v1',
      verdict: 'pass',
      qualifying: false,
      selfCertified: false,
      task: 'change and verify the Xinfa Shifu Kungfu adapter boundary',
      roots: {
        atlas: direct.receipt.atlas_root,
        standalone: standalone.receipt.atlas_root,
        shifu: shifu.xinfa.compile.atlas_root,
        kungfuParity: consumer.parityRoot,
        implementationDrift: drift.receipt.atlas_root,
        nonClaimDrift: narrative.receipt.atlas_root,
        acceptedSuccessor: accepted.receipt.atlas_root,
      },
      paths: {
        standaloneShifuParity: true,
        kungfuReadOnlyPublicCli: consumer.readOnly,
        humanAgentGuiParity: true,
        implementationDriftStale: true,
        expressiveNonClaimNoClaimDrift: true,
        generatedFeedbackRejected: true,
        trackedXinfaUnchanged: true,
        humanProseUnchanged: true,
        explicitAcceptCreatesSuccessor: true,
        oldAtlasStillVerifies: true,
      },
      metrics: {
        directCompileMs: direct.elapsedMs,
        standaloneBuildMs: standaloneBuild.elapsedMs,
        standaloneCompileMs: standalone.elapsedMs,
        shifuAdapterMs: shifuRun.elapsedMs,
        shifuAdapterOverheadMs: Math.max(
          0,
          shifuRun.elapsedMs - direct.elapsedMs,
        ),
        kungfuConsumerMs: consumerElapsedMs,
        taskChartBudget: consumer.metrics.agentBudget,
        taskChartTokens: consumer.metrics.agentTokens,
        humanHops: consumer.metrics.humanHops,
        guiHops: consumer.metrics.guiHops,
        omissions: consumer.metrics.omissions,
      },
      knownLimits: [
        'deterministic full compile only; no native incremental store claim',
        'single-host macOS dogfood; no cross-platform product qualification',
        'thin read-only consumer materialization; no complete GUI browser claim',
        'self-dogfood is not N-1 self-certification or Buildchain release attestation',
      ],
    };
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[xinfa-dogfood] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
