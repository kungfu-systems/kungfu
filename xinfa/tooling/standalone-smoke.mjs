#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'xinfa-standalone-';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return result.stdout.trim();
}

function resolveCargo() {
  const separator = path.delimiter;
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const directories = [
    ...(process.env.SHIFU_ORIGINAL_PATH || '').split(separator),
    ...(process.env.PATH || '').split(separator),
    process.env.HOME ? path.join(process.env.HOME, '.cargo', 'bin') : '',
  ].filter(
    (directory, index, values) =>
      directory &&
      !directory.includes('shifu-cache-overlay-') &&
      values.indexOf(directory) === index,
  );
  for (const directory of directories) {
    const cargo = path.join(directory, executable);
    try {
      fs.accessSync(cargo, fs.constants.X_OK);
      return { cargo, originalPath: directories.join(separator) };
    } catch {
      // Continue until a real, non-overlay Cargo executable is found.
    }
  }
  throw new Error('cargo is not available outside the Shifu cache overlay');
}

function cleanEnvironment(targetRoot, originalPath) {
  const env = {
    ...process.env,
    PATH: originalPath,
    CARGO_TARGET_DIR: path.join(targetRoot, 'target'),
  };
  let removed = 0;
  for (const key of Object.keys(env)) {
    if (key.startsWith('SHIFU_') || key.startsWith('KUNGFU_')) {
      delete env[key];
      removed += 1;
    }
  }
  env.XINFA_STATE_HOME = undefined;
  env.XINFA_CACHE_HOME = undefined;
  return { env, removed };
}

function copyExtraction(targetRoot) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'extraction-manifest.json'), 'utf8'),
  );
  for (const relative of manifest.files) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`unsafe extraction path: ${relative}`);
    }
    const source = path.join(ROOT, relative);
    if (!fs.lstatSync(source).isFile()) {
      throw new Error(`extraction source must be a regular file: ${relative}`);
    }
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return manifest.files;
}

function safeCleanup(targetRoot) {
  const parent = fs.realpathSync(path.dirname(targetRoot));
  const expectedParent = fs.realpathSync(os.tmpdir());
  if (
    parent !== expectedParent ||
    !path.basename(targetRoot).startsWith(PREFIX)
  ) {
    throw new Error(`refusing to clean unowned path: ${targetRoot}`);
  }
  fs.rmSync(targetRoot, { recursive: true });
}

function main() {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  try {
    const canonicalTargetRoot = fs.realpathSync(targetRoot);
    const extractedFiles = copyExtraction(targetRoot);
    const { cargo, originalPath } = resolveCargo();
    const { env, removed } = cleanEnvironment(targetRoot, originalPath);
    const manifest = path.join(targetRoot, 'Cargo.toml');
    run(cargo, ['build', '--locked', '--manifest-path', manifest], {
      cwd: targetRoot,
      env,
    });
    run(cargo, ['test', '--locked', '--manifest-path', manifest], {
      cwd: targetRoot,
      env,
    });

    const binary = path.join(
      targetRoot,
      'target',
      'debug',
      process.platform === 'win32' ? 'xinfa.exe' : 'xinfa',
    );
    const version = run(binary, ['--version'], { cwd: targetRoot, env });
    const contractA = run(binary, ['contract', '--json'], {
      cwd: targetRoot,
      env,
    });
    const contractB = run(binary, ['contract', '--json'], {
      cwd: targetRoot,
      env,
    });
    if (contractA !== contractB)
      throw new Error('contract output is not stable');

    const projectSchema = JSON.parse(
      run(binary, ['schema', 'project'], { cwd: targetRoot, env }),
    );
    const contextIrSchema = JSON.parse(
      run(binary, ['schema', 'context-ir'], { cwd: targetRoot, env }),
    );
    const atlasSchema = JSON.parse(
      run(binary, ['schema', 'atlas'], { cwd: targetRoot, env }),
    );
    const atlasViewSchema = JSON.parse(
      run(binary, ['schema', 'atlas-view'], { cwd: targetRoot, env }),
    );
    const humanViewSchema = JSON.parse(
      run(binary, ['schema', 'human-view'], { cwd: targetRoot, env }),
    );
    const taskChartSchema = JSON.parse(
      run(binary, ['schema', 'task-chart'], { cwd: targetRoot, env }),
    );
    const guiViewSchema = JSON.parse(
      run(binary, ['schema', 'gui-view'], { cwd: targetRoot, env }),
    );
    const projectionRecipeSchema = JSON.parse(
      run(binary, ['schema', 'projection-recipe'], {
        cwd: targetRoot,
        env,
      }),
    );
    if (
      projectSchema.$id !== 'https://xinfa.dev/schema/project-v1.schema.json' ||
      contextIrSchema.$id !==
        'https://xinfa.dev/schema/context-ir-v1.schema.json' ||
      atlasSchema.$id !== 'https://xinfa.dev/schema/atlas-v1.schema.json' ||
      atlasViewSchema.$id !==
        'https://xinfa.dev/schema/atlas-view-v1.schema.json' ||
      humanViewSchema.$id !==
        'https://xinfa.dev/schema/human-view-v1.schema.json' ||
      taskChartSchema.$id !==
        'https://xinfa.dev/schema/task-chart-v1.schema.json' ||
      guiViewSchema.$id !==
        'https://xinfa.dev/schema/gui-view-v1.schema.json' ||
      projectionRecipeSchema.$id !==
        'https://xinfa.dev/schema/projection-recipe-v1.schema.json'
    ) {
      throw new Error('public schema discovery returned unexpected identities');
    }

    const project = path.join(targetRoot, 'fixtures', 'project-alpha.json');
    const validation = JSON.parse(
      run(binary, ['validate', '--project', project, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    if (
      validation.valid !== true ||
      validation.qualifying !== false ||
      validation.selfCertified !== false
    ) {
      throw new Error('project validation receipt crossed its proof boundary');
    }
    const invalidProject = path.join(targetRoot, 'invalid-project.json');
    const invalidValue = JSON.parse(fs.readFileSync(project, 'utf8'));
    invalidValue.schema = 'xinfa.project/v2';
    fs.writeFileSync(invalidProject, `${JSON.stringify(invalidValue)}\n`);
    const invalidValidation = spawnSync(
      binary,
      ['validate', '--project', invalidProject, '--json'],
      { cwd: targetRoot, env, encoding: 'utf8' },
    );
    const invalidReceipt = JSON.parse(invalidValidation.stdout || '{}');
    if (
      invalidValidation.status !== 1 ||
      invalidReceipt.valid !== false ||
      !invalidReceipt.diagnostics?.some(
        (diagnostic) => diagnostic.code === 'unsupported-version',
      )
    ) {
      throw new Error('invalid project did not fail with its stable receipt');
    }
    const canonicalA = run(
      binary,
      ['canonicalize', '--project', project, '--json'],
      { cwd: targetRoot, env },
    );
    const canonicalB = run(
      binary,
      ['canonicalize', '--project', project, '--json'],
      { cwd: targetRoot, env },
    );
    if (canonicalA !== canonicalB)
      throw new Error('project canonicalization is not byte stable');
    const compiled = JSON.parse(
      run(binary, ['compile', '--project', project, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    if (
      compiled.schema !== 'xinfa.context-ir/v1' ||
      compiled.routes.length !== 2 ||
      compiled.routes[0].authorityRoot !== compiled.routes[1].authorityRoot ||
      compiled.routes[0].status !== compiled.routes[1].status
    ) {
      throw new Error('compiled dual-reader route parity failed');
    }

    const repositoryFixture = path.join(
      targetRoot,
      'fixtures',
      'repository-small',
    );
    const packOutput = path.join(targetRoot, 'pack-output');
    const packReceipt = JSON.parse(
      run(
        binary,
        [
          'compile',
          '--project',
          path.join(repositoryFixture, 'project.json'),
          '--output',
          packOutput,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const packVerification = JSON.parse(
      run(binary, ['verify', '--pack', packOutput, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    const packInspection = JSON.parse(
      run(binary, ['inspect', '--pack', packOutput, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    const unchangedImpact = JSON.parse(
      run(
        binary,
        [
          'impact',
          '--since',
          packOutput,
          '--project',
          path.join(repositoryFixture, 'project.json'),
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    if (
      packReceipt.verdict !== 'pass' ||
      packVerification.valid !== true ||
      packInspection.counts.routes !== 2 ||
      unchangedImpact.affectedNodes.length !== 0
    ) {
      throw new Error('repository pack compile/verify/impact contract failed');
    }
    const changedProject = path.join(
      targetRoot,
      'fixtures',
      'repository-small-next',
      'project.json',
    );
    const changedImpact = JSON.parse(
      run(
        binary,
        [
          'impact',
          '--since',
          packOutput,
          '--project',
          changedProject,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    if (
      JSON.stringify(changedImpact.changedSources) !==
        JSON.stringify(['src/runtime.rs']) ||
      !changedImpact.affectedClaims.includes('small.claim.greeting') ||
      !changedImpact.affectedDocuments.includes('small.doc.guide') ||
      changedImpact.affectedRoutes.length !== 2
    ) {
      throw new Error('changed repository impact closure is incomplete');
    }

    const atlasOutput = path.join(targetRoot, 'atlas-output');
    const atlasReceipt = JSON.parse(
      run(
        binary,
        [
          'atlas',
          'compile',
          '--project',
          path.join(repositoryFixture, 'project.json'),
          '--output',
          atlasOutput,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const atlasVerification = JSON.parse(
      run(binary, ['atlas', 'verify', '--atlas', atlasOutput, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    const atlasInspection = JSON.parse(
      run(binary, ['atlas', 'inspect', '--atlas', atlasOutput, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    const atlasDiff = JSON.parse(
      run(
        binary,
        [
          'atlas',
          'diff',
          '--before',
          atlasOutput,
          '--after',
          atlasOutput,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const atlasImpact = JSON.parse(
      run(
        binary,
        [
          'atlas',
          'impact',
          '--since',
          atlasOutput,
          '--project',
          changedProject,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const importedAtlas = path.join(targetRoot, 'imported-atlas');
    const importedReceipt = JSON.parse(
      run(
        binary,
        [
          'atlas',
          'compile',
          '--pack',
          path.join(atlasOutput, 'compatibility', 'context-pack-v1'),
          '--output',
          importedAtlas,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const legacyPackBytes = fs.readFileSync(
      path.join(atlasOutput, 'compatibility', 'context-pack-v1', 'pack.json'),
    );
    const importedPackBytes = fs.readFileSync(
      path.join(importedAtlas, 'compatibility', 'context-pack-v1', 'pack.json'),
    );
    const humanView = JSON.parse(
      fs.readFileSync(path.join(atlasOutput, 'views', 'human.json'), 'utf8'),
    );
    const agentView = JSON.parse(
      fs.readFileSync(path.join(atlasOutput, 'views', 'agent.json'), 'utf8'),
    );
    if (
      atlasReceipt.verdict !== 'pass' ||
      atlasReceipt.context_pack_root !== packReceipt.packRoot ||
      atlasReceipt.atlas_root === packReceipt.packRoot ||
      atlasVerification.valid !== true ||
      atlasInspection.kind !== 'xinfa.atlas/v1' ||
      atlasDiff.unchanged !== true ||
      JSON.stringify(atlasImpact.impact.changedSources) !==
        JSON.stringify(['src/runtime.rs']) ||
      importedReceipt.atlas_root !== atlasReceipt.atlas_root ||
      !legacyPackBytes.equals(importedPackBytes) ||
      humanView.atlas_root !== agentView.atlas_root ||
      JSON.stringify(humanView.shared) !== JSON.stringify(agentView.shared)
    ) {
      throw new Error(
        'Xinfa Atlas compile/verify/diff/impact/import contract failed',
      );
    }

    const humanProjection = JSON.parse(
      run(
        binary,
        [
          'read',
          '--atlas',
          atlasOutput,
          '--route',
          'small.human',
          '--intent',
          'understand runtime greeting',
          '--surface',
          'human',
          '--max-hops',
          '2',
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const guiProjection = JSON.parse(
      run(
        binary,
        [
          'read',
          '--atlas',
          atlasOutput,
          '--route',
          'small.human',
          '--intent',
          'understand runtime greeting',
          '--surface',
          'gui',
          '--max-hops',
          '2',
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const chartText = run(
      binary,
      [
        'chart',
        'create',
        '--atlas',
        atlasOutput,
        '--route',
        'small.agent',
        '--task',
        'change runtime greeting',
        '--role',
        'implementer',
        '--budget',
        '4096',
        '--json',
      ],
      { cwd: targetRoot, env },
    );
    const contextText = run(
      binary,
      [
        'context',
        '--atlas',
        atlasOutput,
        '--route',
        'small.agent',
        '--task',
        'change runtime greeting',
        '--role',
        'implementer',
        '--budget',
        '4096',
        '--json',
      ],
      { cwd: targetRoot, env },
    );
    if (chartText !== contextText) {
      throw new Error('context is not a byte-stable Task Chart alias');
    }
    const chart = JSON.parse(chartText);
    const chartPath = path.join(targetRoot, 'task-chart.json');
    fs.writeFileSync(chartPath, `${chartText}\n`);
    const chartInspection = JSON.parse(
      run(binary, ['chart', 'inspect', '--chart', chartPath, '--json'], {
        cwd: targetRoot,
        env,
      }),
    );
    const chartVerification = JSON.parse(
      run(
        binary,
        [
          'chart',
          'verify',
          '--chart',
          chartPath,
          '--atlas',
          atlasOutput,
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const degradedText = run(
      binary,
      [
        'chart',
        'create',
        '--atlas',
        atlasOutput,
        '--route',
        'small.agent',
        '--task',
        'change runtime greeting',
        '--role',
        'implementer',
        '--budget',
        '80',
        '--json',
      ],
      { cwd: targetRoot, env },
    );
    const degraded = JSON.parse(degradedText);
    const degradedPath = path.join(targetRoot, 'degraded-chart.json');
    fs.writeFileSync(degradedPath, `${degradedText}\n`);
    const expansion = JSON.parse(
      run(
        binary,
        [
          'expand',
          '--atlas',
          atlasOutput,
          '--view',
          degradedPath,
          '--handle',
          degraded.expansion_handles[0].id,
          '--budget',
          '4096',
          '--json',
        ],
        { cwd: targetRoot, env },
      ),
    );
    const parityFields = [
      'atlas_root',
      'cut_root',
      'evidence',
      'atlas_omissions',
    ];
    for (const field of parityFields) {
      const humanValue =
        field === 'atlas_root' || field === 'cut_root'
          ? humanProjection[field]
          : humanProjection.parity[field];
      const chartValue =
        field === 'atlas_root' || field === 'cut_root'
          ? chart[field]
          : chart.parity[field];
      const guiValue =
        field === 'atlas_root' || field === 'cut_root'
          ? guiProjection[field]
          : guiProjection.parity[field];
      if (
        JSON.stringify(humanValue) !== JSON.stringify(chartValue) ||
        JSON.stringify(humanValue) !== JSON.stringify(guiValue)
      ) {
        throw new Error(`projection parity diverged at ${field}`);
      }
    }
    if (
      humanProjection.schema !== 'xinfa.human-view/v1' ||
      guiProjection.schema !== 'xinfa.gui-view/v1' ||
      chart.schema !== 'xinfa.task-chart/v1' ||
      chart.status !== 'complete' ||
      chartInspection.valid_structure !== true ||
      chartVerification.valid !== true ||
      degraded.status !== 'degraded' ||
      degraded.omissions.length === 0 ||
      expansion.atlas_root !== degraded.atlas_root ||
      expansion.cut_root !== degraded.cut_root ||
      expansion.predecessor_root !== degraded.projection_root ||
      chart.materialization.provider_input !== 'excluded' ||
      chart.materialization.promotion.same_cut_allowed !== false ||
      fs.existsSync(path.join(repositoryFixture, '.xinfa', 'generated'))
    ) {
      throw new Error(
        'bounded projection, expansion, or ownership contract failed',
      );
    }

    const feedbackProject = JSON.parse(
      fs.readFileSync(path.join(repositoryFixture, 'project.json'), 'utf8'),
    );
    const generatedDirectory = path.join(
      repositoryFixture,
      '.xinfa',
      'generated',
    );
    fs.mkdirSync(generatedDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(generatedDirectory, 'task-chart.json'),
      chartText,
    );
    feedbackProject.providers[0].paths.push('.xinfa/generated/task-chart.json');
    const feedbackProjectPath = path.join(
      repositoryFixture,
      'feedback-project.json',
    );
    fs.writeFileSync(
      feedbackProjectPath,
      `${JSON.stringify(feedbackProject)}\n`,
    );
    const feedbackCompile = spawnSync(
      binary,
      [
        'compile',
        '--project',
        feedbackProjectPath,
        '--output',
        path.join(targetRoot, 'feedback-output'),
        '--json',
      ],
      { cwd: targetRoot, env, encoding: 'utf8' },
    );
    const feedbackReceipt = JSON.parse(feedbackCompile.stdout || '{}');
    if (
      feedbackCompile.status !== 1 ||
      !feedbackReceipt.diagnostics?.some(
        (item) => item.code === 'generated-projection-input',
      )
    ) {
      throw new Error('generated projection feedback was not rejected');
    }
    const maliciousOutput = path.join(targetRoot, 'malicious-output');
    const maliciousProject = path.join(
      targetRoot,
      'fixtures',
      'repository-malicious',
      'project.json',
    );
    const maliciousCompile = spawnSync(
      binary,
      [
        'compile',
        '--project',
        maliciousProject,
        '--output',
        maliciousOutput,
        '--json',
      ],
      { cwd: targetRoot, env, encoding: 'utf8' },
    );
    const maliciousReceipt = JSON.parse(maliciousCompile.stdout || '{}');
    if (
      maliciousCompile.status !== 1 ||
      !maliciousReceipt.diagnostics?.some(
        (item) => item.code === 'sensitive-path',
      ) ||
      fs.existsSync(maliciousOutput)
    ) {
      throw new Error(
        'malicious repository did not fail closed without output',
      );
    }

    const diagnostic = JSON.parse(
      run(binary, ['diagnose', '--json'], { cwd: targetRoot, env }),
    );
    if (
      diagnostic.stateHome !== path.join(canonicalTargetRoot, '.xinfa') ||
      diagnostic.cacheHome !==
        path.join(canonicalTargetRoot, '.xinfa', 'cache') ||
      diagnostic.writesState !== false
    ) {
      throw new Error(
        'default state diagnostic violates the standalone contract',
      );
    }

    const overrideEnv = {
      ...env,
      XINFA_STATE_HOME: path.join(targetRoot, 'state-override'),
      XINFA_CACHE_HOME: path.join(targetRoot, 'cache-override'),
    };
    const overrideDiagnostic = JSON.parse(
      run(binary, ['diagnose', '--json'], {
        cwd: targetRoot,
        env: overrideEnv,
      }),
    );
    if (
      overrideDiagnostic.stateSource !== 'environment' ||
      overrideDiagnostic.cacheSource !== 'environment' ||
      overrideDiagnostic.writesState !== false
    ) {
      throw new Error('state overrides violate the standalone contract');
    }
    if (
      fs.existsSync(diagnostic.stateHome) ||
      fs.existsSync(overrideDiagnostic.stateHome) ||
      fs.existsSync(overrideDiagnostic.cacheHome)
    ) {
      throw new Error(
        'read-only diagnostics created state or cache directories',
      );
    }

    const receipt = {
      schema: 'xinfa.standalone-smoke-receipt/v1',
      verdict: 'pass',
      product: 'xinfa',
      version,
      extractedFiles: [...extractedFiles].sort(),
      contractSha256: crypto
        .createHash('sha256')
        .update(contractA)
        .digest('hex'),
      contractDeterministic: true,
      projectSchema: projectSchema.$id,
      contextIrSchema: contextIrSchema.$id,
      projectRoot: validation.projectRoot,
      authorityRoot: compiled.roots.authority,
      canonicalizationDeterministic: true,
      dualReaderParity: true,
      repositoryPackRoot: packReceipt.packRoot,
      repositoryPackDeterministic: true,
      repositoryPackOfflineVerify: true,
      repositoryPackImpact: true,
      xinfaAtlasRoot: atlasReceipt.atlas_root,
      xinfaAtlasDeterministic: true,
      xinfaAtlasOfflineVerify: true,
      xinfaAtlasDiff: true,
      xinfaAtlasImpact: true,
      xinfaAtlasContextPackImport: true,
      xinfaAtlasLegacyPackBytesUnchanged: true,
      xinfaAtlasDualViewIdentity: true,
      humanViewSchema: humanViewSchema.$id,
      taskChartSchema: taskChartSchema.$id,
      guiViewSchema: guiViewSchema.$id,
      projectionRecipeSchema: projectionRecipeSchema.$id,
      boundedHumanView: true,
      boundedTaskChart: true,
      guiView: true,
      projectionParity: true,
      budgetOmissionsExplicit: true,
      stableExpansionHandles: true,
      expansionPreservesCut: true,
      contextAliasByteStable: true,
      generatedProjectionFeedbackRejected: true,
      ordinaryProjectionWritesTrackedXinfa: false,
      maliciousRepositoryRejected: true,
      validationQualifying: false,
      invalidProjectExitCode: 1,
      cargoBuild: 'pass',
      cargoTest: 'pass',
      stateDefault: '.xinfa',
      stateOverride: 'XINFA_STATE_HOME',
      cacheOverride: 'XINFA_CACHE_HOME',
      diagnosticsWriteState: false,
      scrubbedEnvironmentPrefixes: ['KUNGFU_', 'SHIFU_'],
      scrubbedEnvironmentVariables: removed,
    };
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    safeCleanup(targetRoot);
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[xinfa-standalone] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
