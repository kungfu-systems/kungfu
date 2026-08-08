// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm']);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DARWIN_X64_POLICY_PATH = 'docs/shifu/darwin-x64-residual-policy.json';
const DARWIN_X64_RESIDUAL_PATTERN =
  /darwin[-/](?:x64|x86_64)|darwin_x86_64|macos[-/](?:x64|x86_64)|macosx_[^\s"']*_x86_64|x86_64-apple-darwin|intel macos|shifu-macos-x64|uv-x86_64-apple-darwin|macos-15-intel/giu;

export function platformCommand(command, platform = process.platform) {
  return platform === 'win32' && WINDOWS_SHIMS.has(command)
    ? `${command}.cmd`
    : command;
}

export function platformCommandOptions(command, platform = process.platform) {
  return {
    shell: platform === 'win32' && WINDOWS_SHIMS.has(command),
  };
}

export function pythonCommand(
  platform = process.platform,
  configured = process.env.PYTHON,
) {
  return configured || (platform === 'win32' ? 'uv' : 'python3');
}

export function pythonCommandArgs(
  args,
  {
    platform = process.platform,
    configured = process.env.PYTHON,
    project = '',
  } = {},
) {
  if (platform !== 'win32' || configured) return args;
  if (!project)
    throw new Error(
      'a pinned uv project is required for the Windows Python command',
    );
  return ['run', '--project', project, '--frozen', 'python', ...args];
}

export function prependEnvironmentPath(
  environment,
  directory,
  platform = process.platform,
) {
  const result = { ...environment };
  const key =
    platform === 'win32'
      ? Object.keys(result).find((name) => name.toLowerCase() === 'path') ||
        'Path'
      : 'PATH';
  result[key] = [directory, result[key]]
    .filter(Boolean)
    .join(platform === 'win32' ? ';' : ':');
  return result;
}

function repositoryFiles(root) {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

function darwinX64Category(relative, line, policy) {
  for (const [category, rule] of Object.entries(policy.categories)) {
    if (
      rule.paths.includes(relative) ||
      rule.prefixes.some((prefix) => relative.startsWith(prefix)) ||
      (rule.linePatterns[relative] || []).some((pattern) =>
        new RegExp(pattern, 'u').test(line),
      )
    ) {
      return category;
    }
  }
  return null;
}

export function classifyDarwinX64Residuals(entries, policy) {
  const categories = Object.fromEntries(
    Object.keys(policy.categories).map((category) => [category, []]),
  );
  const unclassified = [];
  for (const entry of entries) {
    if (entry.content.includes('\0')) continue;
    const lines = entry.content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const matches = [
        ...lines[index].matchAll(DARWIN_X64_RESIDUAL_PATTERN),
      ].map((match) => match[0]);
      if (matches.length === 0) continue;
      const residual = {
        path: entry.path,
        line: index + 1,
        matches: [...new Set(matches)].sort(),
      };
      const category = darwinX64Category(entry.path, lines[index], policy);
      if (category) categories[category].push(residual);
      else unclassified.push(residual);
    }
  }
  return {
    schema: 'kungfu.darwin-x64-residual-classification/v1',
    status: unclassified.length === 0 ? 'pass' : 'fail',
    policy: DARWIN_X64_POLICY_PATH,
    categories,
    unclassified,
  };
}

export function classifyDarwinX64Repository(root = ROOT) {
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, DARWIN_X64_POLICY_PATH), 'utf8'),
  );
  const entries = repositoryFiles(root)
    .filter((relative) => fs.existsSync(path.join(root, relative)))
    .map((relative) => ({
      path: relative,
      content: fs.readFileSync(path.join(root, relative), 'utf8'),
    }));
  return classifyDarwinX64Residuals(entries, policy);
}

function checkDarwinX64Retirement() {
  const report = classifyDarwinX64Repository();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === '--check-darwin-x64-retirement'
) {
  checkDarwinX64Retirement();
}
