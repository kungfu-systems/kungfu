#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeValeProjection } from './vocabulary-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLCHAIN = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'docs', 'toolchain.contract.json'), 'utf8'),
);
const required = process.argv.includes('--required');
const annotations =
  process.argv.includes('--github-annotations') ||
  process.env.GITHUB_ACTIONS === 'true';
const minAlertLevel = required ? 'error' : 'warning';
const IMAGE = TOOLCHAIN.vale.container;

function vale(prefix, files) {
  const result = spawnSync('docker', [...prefix, '--output=JSON', ...files], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error)
    throw new Error(
      `pinned Vale container could not start: ${result.error.message}`,
    );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(
      `Vale did not return JSON: ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  const findings = [];
  for (const [file, alerts] of Object.entries(parsed || {}))
    for (const alert of Array.isArray(alerts) ? alerts : [])
      findings.push({
        file: file.replace(/^\/work\//, ''),
        line: Number(alert.Line || 1),
        column: Number(alert.Span?.[0] || 1),
        severity: String(alert.Severity || 'warning').toLowerCase(),
        rule: String(alert.Check || 'Vale'),
        message: String(alert.Message || 'prose policy finding'),
      });
  if (result.status !== 0 && findings.length === 0) {
    throw new Error(
      `pinned Vale container failed with exit ${String(result.status)}: ` +
        `${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return { findings, status: result.status, stderr: result.stderr || '' };
}

function escapeAnnotation(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

// Docker Desktop only shares host paths selected by the desktop account. An
// Actions runner can execute from another user's worktree, so both os.tmpdir()
// and the runner's home may produce bind sources that the Docker VM sees as
// empty. Keep the disposable projection below the already-mounted checkout.
const temporaryRoot = path.join(ROOT, '.buildchain', 'tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryRoot, 'kungfu-vale-'));
// mkdtemp uses 0700. OrbStack runs the Docker file-sharing service as the
// desktop account, which differs from the Actions runner account, so the bind
// source must be traversable while the container is alive.
if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755);
try {
  if (
    TOOLCHAIN.schemaVersion !== 1 ||
    TOOLCHAIN.vale.version !== '3.14.2' ||
    !/@sha256:[0-9a-f]{64}$/.test(IMAGE)
  )
    throw new Error('invalid pinned Vale toolchain contract');
  const projection = writeValeProjection(temporary, { minAlertLevel });
  const prefix = [
    'run',
    '--init',
    '--rm',
    '-v',
    `${ROOT}:/work:ro`,
    '-v',
    `${temporary}:/vale-config:ro`,
    '-w',
    '/work',
    IMAGE,
    '--config=/vale-config/.vale.ini',
  ];
  for (const fixture of projection.requiredFixtures) {
    const file = path.join(temporary, `${fixture.id}.md`);
    fs.writeFileSync(file, `# Negative fixture\n\n${fixture.text}\n`);
    const proof = vale(prefix, [`/vale-config/${fixture.id}.md`]);
    if (!proof.findings.some((finding) => finding.rule === fixture.style))
      throw new Error(
        `negative fixture did not prove ${fixture.style}; ` +
          `vale_status=${String(proof.status)} ` +
          `rules=${JSON.stringify(proof.findings.map((finding) => finding.rule))} ` +
          `stderr=${JSON.stringify(proof.stderr.trim())}`,
      );
  }
  const result = vale(
    prefix,
    projection.files.map((file) => `/work/${file}`),
  );
  const metrics = {
    schema: 'kungfu.docs-vale-report/v1',
    valeVersion: TOOLCHAIN.vale.version,
    minimumLevel: minAlertLevel,
    files: projection.files.length,
    findings: result.findings,
    counts: {
      error: result.findings.filter((item) => item.severity === 'error').length,
      warning: result.findings.filter((item) => item.severity === 'warning')
        .length,
      suggestion: result.findings.filter(
        (item) => item.severity === 'suggestion',
      ).length,
    },
  };
  if (process.env.KUNGFU_VALE_REPORT) {
    fs.mkdirSync(path.dirname(process.env.KUNGFU_VALE_REPORT), {
      recursive: true,
    });
    fs.writeFileSync(
      process.env.KUNGFU_VALE_REPORT,
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
  }
  if (annotations)
    for (const finding of result.findings)
      console.log(
        `::${finding.severity === 'error' ? 'error' : 'warning'} file=${escapeAnnotation(finding.file)},line=${finding.line},col=${finding.column},title=${escapeAnnotation(finding.rule)}::${escapeAnnotation(finding.message)}`,
      );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Kungfu Vale report\n\n| Files | Errors | Warnings | Suggestions |\n| ---: | ---: | ---: | ---: |\n| ${metrics.files} | ${metrics.counts.error} | ${metrics.counts.warning} | ${metrics.counts.suggestion} |\n\nPolicy source: \`docs/vocabulary.registry.json\`.\n`,
    );
  console.log(
    `[docs:prose] files=${metrics.files} errors=${metrics.counts.error} warnings=${metrics.counts.warning} suggestions=${metrics.counts.suggestion}`,
  );
  if (required && result.findings.length)
    throw new Error('required prose policy findings remain');
} catch (error) {
  console.error(
    `[docs:prose] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
