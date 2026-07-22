#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.resolve(harnessDir, '..', '..', '..');
const rootDir = path.resolve(coreDir, '..', '..');
const sourceManifest = path.join(
  coreDir,
  'src',
  'kfd-agent-runtime',
  'kfd-agent-runtime.manifest.json',
);
const boundaryCheck = path.join(
  rootDir,
  'scripts',
  'check-kfd-agent-runtime-boundary.mjs',
);
const badAdapterSource = path.join(harnessDir, 'bad-adapter.mjs');
const require = createRequire(import.meta.url);

function fail(message) {
  throw new Error(`KFD Agent Runtime qualification: ${message}`);
}

function parseArgs(argv) {
  const options = {
    kfdRoot: process.env.KFD_PACKAGE_ROOT || '',
    runtimeDist:
      process.env.KUNGFU_RUNTIME_DIST || path.join(coreDir, 'dist', 'kungfu'),
    outputDir: '',
    keepRuntime: false,
    allowDirty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--kfd-root') options.kfdRoot = next();
    else if (arg === '--runtime-dist') options.runtimeDist = next();
    else if (arg === '--output-dir') options.outputDir = next();
    else if (arg === '--keep-runtime') options.keepRuntime = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`KFD Agent Runtime qualification

Usage:
  ./shifu kfd:agent-runtime:qualify -- [options]

Options:
  --kfd-root PATH       KFD checkout or installed package root
  --runtime-dist PATH   frozen Kungfu runtime directory
  --output-dir PATH     retained evidence directory
  --keep-runtime        retain the disposable scratch runtime
  --allow-dirty         emit development-pass evidence from a dirty source tree
`);
      process.exit(0);
    } else fail(`unknown argument '${arg}'`);
  }
  return options;
}

function resolveKfdRoot(configured) {
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  try {
    candidates.push(
      path.dirname(require.resolve('@kungfu-tech/kfd/package.json')),
    );
  } catch {
    // The explicit path error below is more useful.
  }
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'bin', 'kfd.mjs')) &&
      fs.existsSync(
        path.join(
          candidate,
          'profiles',
          'agent-runtime',
          'vectors',
          'runtime-100.json',
        ),
      )
    ) {
      return candidate;
    }
  }
  fail(
    'KFD package with the agent-runtime profile not found; pass --kfd-root or KFD_PACKAGE_ROOT',
  );
}

function sha256File(file) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')}`;
}

function sha256Text(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout || 120_000,
  });
  if (options.expectFailure) {
    if (result.status === 0) {
      fail(`${options.label || command} unexpectedly passed`);
    }
    return result;
  }
  if (result.status !== 0) {
    fail(
      `${options.label || command} failed (${result.status ?? result.signal})\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function git(args) {
  return run('git', args, { cwd: rootDir, label: `git ${args.join(' ')}` })
    .stdout;
}

function sourceIdentity() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const diff = git(['diff', '--binary', 'HEAD']);
  return {
    repository: 'kungfu-systems/kungfu',
    head,
    clean: status.trim() === '',
    workingTreeDigest: sha256Text(diff),
  };
}

function copyRuntimeArtifact(runtimeDist, scratch) {
  const runtime = path.join(scratch, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const adapterName =
    process.platform === 'win32'
      ? 'kungfu-kfd-agent-runtime.exe'
      : 'kungfu-kfd-agent-runtime';
  const adapterSource = path.join(runtimeDist, adapterName);
  if (!fs.existsSync(adapterSource)) {
    fail(`frozen adapter not found: ${adapterSource}; run ./shifu freeze`);
  }
  const copied = [];
  for (const entry of fs.readdirSync(runtimeDist)) {
    if (
      entry === adapterName ||
      entry === 'kfd-agent-runtime.manifest.json' ||
      /^libkungfu_runtime\.(?:dylib|so(?:\..*)?)$/.test(entry) ||
      /^kungfu\.dll$/i.test(entry) ||
      /^kungfu_(?:embedding|native_storage)\.dll$/i.test(entry)
    ) {
      const source = path.join(runtimeDist, entry);
      const target = path.join(runtime, entry);
      fs.copyFileSync(source, target);
      copied.push(target);
    }
  }
  if (!copied.some((file) => path.basename(file) === adapterName)) {
    fail('adapter copy did not produce a scratch artifact');
  }
  const manifestTarget = path.join(runtime, 'kfd-agent-runtime.manifest.json');
  if (!fs.existsSync(manifestTarget)) {
    fs.copyFileSync(sourceManifest, manifestTarget);
    copied.push(manifestTarget);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(runtime, adapterName), 0o755);
  }
  return {
    root: runtime,
    adapter: path.join(runtime, adapterName),
    manifest: manifestTarget,
    files: copied,
  };
}

function parseJsonOutput(output, label) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Continue through human-readable status lines.
    }
  }
  fail(`${label} did not emit JSON`);
}

async function readLine(iterator, label) {
  let timer;
  try {
    return await Promise.race([
      iterator.next().then((result) => {
        if (result.done) fail(`${label} closed stdout before responding`);
        return JSON.parse(result.value);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function request(requestId, operation, input = undefined) {
  const actionBinding = {
    factCutRoot: `sha256:${'1'.repeat(64)}`,
    pursuitRoot: `sha256:${'2'.repeat(64)}`,
    atlasRoot: `sha256:${'3'.repeat(64)}`,
    warrantRoot: `sha256:${'4'.repeat(64)}`,
    candidateActionRoot: `sha256:${'5'.repeat(64)}`,
    preconditionsRoot: `sha256:${'6'.repeat(64)}`,
    resourcesRoot: `sha256:${'7'.repeat(64)}`,
  };
  return {
    schemaVersion: 1,
    contract: 'kfd.agent-runtime-adapter-request/v1',
    requestId,
    operation,
    ...(input === undefined
      ? {}
      : {
          input: operation === 'evaluate' ? { ...input, actionBinding } : input,
        }),
  };
}

function acceptedPursuit(requestId) {
  return request(requestId, 'evaluate', {
    category: 'pursuit',
    operation: 'pursuit.create',
    input: { state: null, target: { id: requestId, version: 1 } },
  });
}

async function crashAndReopen(adapter, runtimeDir, scratch) {
  const env = { ...process.env, KUNGFU_KFD_RUNTIME_DIR: runtimeDir };
  const child = spawn(adapter, [], {
    cwd: scratch,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(
    `${JSON.stringify(request('qualification-handshake-before-kill', 'handshake'))}\n`,
  );
  const handshake = await readLine(iterator, 'pre-crash handshake');
  assert.equal(handshake.status, 'accepted');
  child.stdin.write(
    `${JSON.stringify(acceptedPursuit('qualification-crash-before-kill'))}\n`,
  );
  const beforeKill = await readLine(iterator, 'pre-crash transition');
  assert.equal(beforeKill.status, 'accepted');
  child.kill('SIGKILL');
  await once(child, 'close');
  if (stderr.trim())
    fail(`adapter wrote stderr before forced termination: ${stderr}`);

  const reopenInput = [
    request('qualification-handshake-after-kill', 'handshake'),
    acceptedPursuit('qualification-reopen-after-kill'),
  ]
    .map((value) => JSON.stringify(value))
    .join('\n');
  const reopened = run(adapter, [], {
    cwd: scratch,
    env,
    input: `${reopenInput}\n`,
    label: 'forced-termination reopen probe',
  });
  if (reopened.stderr.trim()) {
    fail(`reopened adapter wrote stderr: ${reopened.stderr}`);
  }
  const responses = reopened.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].status, 'accepted');
  assert.equal(responses[1].status, 'accepted');
  return {
    terminatedProcess: {
      signal: process.platform === 'win32' ? 'TerminateProcess' : 'SIGKILL',
      acceptedResponseObservedBeforeTermination: true,
    },
    reopen: {
      handshake: responses[0].code,
      acceptedTransition: responses[1].code,
    },
  };
}

function inspectRuntime(runtimeDist, runtimeDir) {
  const python =
    process.platform === 'win32'
      ? path.join(runtimeDist, 'python', 'python.exe')
      : path.join(runtimeDist, 'python', 'bin', 'python3');
  if (!fs.existsSync(python)) {
    fail(`frozen Python inspector not found: ${python}`);
  }
  const script = [
    'import json, sys',
    'from kungfu.storage import service',
    'runtime = sys.argv[1]',
    'print(json.dumps({"episodes": service.episode_list(runtime, limit=0), "fsck": service.fsck(runtime)}, sort_keys=True))',
  ].join('; ');
  return parseJsonOutput(
    run(python, ['-c', script, runtimeDir], {
      cwd: path.dirname(runtimeDir),
      label: 'installed Python native storage inspection',
    }).stdout,
    'installed Python native storage inspection',
  );
}

function validateQualificationReport(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(
    report.contract,
    'kungfu.kfd-agent-runtime.qualification-report/v1',
  );
  assert.ok(['passed', 'development-pass'].includes(report.verdict));
  assert.equal(report.kfd.report.valid, true);
  assert.equal(report.kfd.verifier.valid, true);
  assert.equal(report.kfd.report.partitions.core.status, 'pass');
  assert.equal(report.kfd.report.partitions.experimental.status, 'pass');
  assert.equal(report.negativeFalsification.status, 'passed');
  assert.equal(report.faultEvidence.fsck.ok, true);
  assert.ok(report.residualRisk.length > 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const kfdRoot = resolveKfdRoot(options.kfdRoot);
  const kfdCli = path.join(kfdRoot, 'bin', 'kfd.mjs');
  const source = sourceIdentity();
  if (!source.clean && !options.allowDirty) {
    fail('source tree is dirty; commit the exact source or pass --allow-dirty');
  }

  const outputDir = path.resolve(
    options.outputDir ||
      path.join(
        coreDir,
        'build',
        'qualification',
        'kfd-agent-runtime',
        new Date().toISOString().replaceAll(/[:.]/g, '-'),
      ),
  );
  if (fs.existsSync(outputDir)) fail(`output already exists: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-kfd-agent-runtime-'),
  );
  try {
    const boundary = parseJsonOutput(
      run(process.execPath, [boundaryCheck], {
        cwd: rootDir,
        label: 'public boundary source gate',
      }).stdout,
      'public boundary source gate',
    );
    const artifact = copyRuntimeArtifact(
      path.resolve(options.runtimeDist),
      scratch,
    );
    const runtimeDir = path.join(scratch, 'qualification.kungfu');
    const reportPath = path.join(scratch, 'kfd-report.json');
    const env = {
      ...process.env,
      KUNGFU_KFD_RUNTIME_DIR: runtimeDir,
    };
    run(
      process.execPath,
      [
        kfdCli,
        'test',
        'agent-runtime',
        '--adapter',
        artifact.adapter,
        '--output',
        reportPath,
      ],
      {
        cwd: scratch,
        env,
        label: 'KFD Runtime 100',
      },
    );
    const kfdReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(kfdReport.valid, true);
    assert.equal(kfdReport.suite.vectorCount, 100);
    assert.equal(
      kfdReport.suite.vectorRoot,
      'sha256:1e996b8c43b0b3e38630ccd58acf8a714cbc24b339d3794318347faab9057e5f',
    );
    assert.equal(kfdReport.partitions.core.status, 'pass');
    assert.equal(kfdReport.partitions.experimental.status, 'pass');
    assert.equal(
      kfdReport.adapter.artifactDigest,
      sha256File(artifact.adapter),
    );

    const verifier = parseJsonOutput(
      run(
        process.execPath,
        [kfdCli, 'verify', 'agent-runtime-report', reportPath, '--json'],
        {
          cwd: scratch,
          label: 'KFD independent offline verifier',
        },
      ).stdout,
      'KFD independent offline verifier',
    );
    assert.equal(verifier.valid, true);

    const badScript = path.join(scratch, 'bad-adapter.mjs');
    fs.copyFileSync(badAdapterSource, badScript);
    let badAdapter = badScript;
    if (process.platform === 'win32') {
      badAdapter = path.join(scratch, 'bad-adapter.cmd');
      fs.writeFileSync(
        badAdapter,
        `@"${process.execPath}" "${badScript}" %*\r\n`,
      );
    } else {
      fs.chmodSync(badScript, 0o755);
    }
    const badReportPath = path.join(scratch, 'bad-adapter-report.json');
    run(
      process.execPath,
      [
        kfdCli,
        'test',
        'agent-runtime',
        '--adapter',
        badAdapter,
        '--output',
        badReportPath,
      ],
      {
        cwd: scratch,
        env: {
          ...process.env,
          KUNGFU_KFD_RUNTIME_DIR: path.join(scratch, 'bad.kungfu'),
        },
        label: 'deliberately invalid adapter falsification',
        expectFailure: true,
      },
    );
    const badReport = JSON.parse(fs.readFileSync(badReportPath, 'utf8'));
    const failedIds = new Set(
      badReport.results
        .filter((result) => result.status === 'fail')
        .map((result) => result.id),
    );
    const requiredNegativeIds = [
      'pursuit-004-reject-stale-revision',
      'pursuit-011-reject-sealed-episode-as-settlement',
      'pursuit-012-reject-fact-admission-as-settlement',
      'warrant-004-reject-action-amplification',
      'recovery-002-reject-ack-before-durability',
      'recovery-004-reject-reopen-provider-drift',
    ];
    for (const id of requiredNegativeIds) {
      assert.equal(failedIds.has(id), true, `bad adapter escaped ${id}`);
    }

    const processFault = await crashAndReopen(
      artifact.adapter,
      runtimeDir,
      scratch,
    );
    const inspection = inspectRuntime(
      path.resolve(options.runtimeDist),
      runtimeDir,
    );
    const retainedEpisodeCount = inspection.episodes.episodes.length;
    assert.equal(
      retainedEpisodeCount,
      2,
      'the two explicitly bound forced-restart probes must each retain one Episode',
    );
    assert.equal(inspection.fsck.ok, true);

    const retainedKfdReport = path.join(outputDir, 'kfd-report.json');
    const retainedVerifier = path.join(
      outputDir,
      'kfd-verification-report.json',
    );
    const retainedBadReport = path.join(outputDir, 'bad-adapter-report.json');
    fs.copyFileSync(reportPath, retainedKfdReport);
    writeJson(retainedVerifier, verifier);
    fs.copyFileSync(badReportPath, retainedBadReport);

    const manifest = JSON.parse(fs.readFileSync(artifact.manifest, 'utf8'));
    const report = {
      schemaVersion: 1,
      contract: 'kungfu.kfd-agent-runtime.qualification-report/v1',
      verdict: source.clean ? 'passed' : 'development-pass',
      claim:
        'The exact frozen Kungfu adapter artifact passed KFD Runtime 100 on the observed platform; Experimental results remain non-normative.',
      source,
      platform: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
      },
      artifacts: {
        adapter: {
          basename: path.basename(artifact.adapter),
          sha256: sha256File(artifact.adapter),
        },
        manifest: {
          sha256: sha256File(artifact.manifest),
          document: manifest,
        },
        runtimeFiles: artifact.files
          .filter((file) => fs.existsSync(file))
          .map((file) => ({
            basename: path.basename(file),
            sha256: sha256File(file),
          }))
          .sort((left, right) => left.basename.localeCompare(right.basename)),
      },
      kfd: {
        package: {
          version: JSON.parse(
            fs.readFileSync(path.join(kfdRoot, 'package.json'), 'utf8'),
          ).version,
        },
        report: {
          path: path.basename(retainedKfdReport),
          sha256: sha256File(retainedKfdReport),
          valid: kfdReport.valid,
          qualifying: kfdReport.qualifying,
          selfCertified: kfdReport.selfCertified,
          profile: kfdReport.profile,
          suite: kfdReport.suite,
          partitions: kfdReport.partitions,
          resultRoot: kfdReport.execution.resultRoot,
          transcriptRoot: kfdReport.execution.transcriptRoot,
        },
        verifier: {
          path: path.basename(retainedVerifier),
          sha256: sha256File(retainedVerifier),
          valid: verifier.valid,
          offline: verifier.offline,
          checks: verifier.checks,
        },
      },
      negativeFalsification: {
        status: 'passed',
        fixture: 'deliberately-invalid-always-accept',
        report: {
          path: path.basename(retainedBadReport),
          sha256: sha256File(retainedBadReport),
        },
        requiredFailures: requiredNegativeIds,
        observedFailureCount: failedIds.size,
      },
      faultEvidence: {
        disposableRuntime: true,
        processFault,
        retainedEpisodes: {
          expected: 2,
          observed: retainedEpisodeCount,
          boundary:
            'KFD Runtime 100 evaluates the standard semantic protocol without a Kungfu ActionBinding; only explicitly bound probes request native Episode retention.',
        },
        fsck: {
          ok: inspection.fsck.ok,
          document: inspection.fsck,
        },
      },
      languageProjection: {
        semanticEvaluatorAuthority: 'cxx-adapter-only',
        cAbi: boundary,
        node: {
          role: 'KFD JSONL process runner',
          resultRoot: kfdReport.execution.resultRoot,
        },
        python: {
          role: 'installed native-storage evidence inspector',
          retainedEpisodeCount,
        },
        difference:
          'Node and Python intentionally do not expose duplicate KFD evaluators; KFD semantic responses are independent of the optional Kungfu ActionBinding extension, while Python inspects Episodes from explicitly bound storage probes.',
      },
      residualRisk: [
        ...kfdReport.residualRisk,
        `Only ${process.platform}/${process.arch} was observed by this report; other platforms require their own exact reports.`,
        'Forced process termination proves local reopen and fsck behavior, not physical power-loss durability.',
        'No external adopter is asserted.',
      ],
    };
    validateQualificationReport(report);
    const qualificationPath = path.join(outputDir, 'qualification-report.json');
    writeJson(qualificationPath, report);
    process.stdout.write(
      `[kfd-agent-runtime] verdict=${report.verdict} core=${kfdReport.partitions.core.passed}/${kfdReport.partitions.core.total} experimental=${kfdReport.partitions.experimental.passed}/${kfdReport.partitions.experimental.total}\n`,
    );
    process.stdout.write(`[kfd-agent-runtime] report=${qualificationPath}\n`);
    if (!source.clean && !options.allowDirty) process.exitCode = 1;
  } finally {
    if (options.keepRuntime) {
      process.stdout.write(`[kfd-agent-runtime] scratch=${scratch}\n`);
    } else {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

await main();
