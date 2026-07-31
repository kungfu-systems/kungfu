#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Windows Alpha runner adapter for the pinned compiler-cache tool.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WINDOWS_SCCACHE_VERSION = '0.16.0';
export const WINDOWS_SCCACHE_TARGET = 'x86_64-pc-windows-msvc';
export const WINDOWS_SCCACHE_ARCHIVE_URL =
  'https://github.com/mozilla/sccache/releases/download/v0.16.0/sccache-v0.16.0-x86_64-pc-windows-msvc.zip';
export const WINDOWS_SCCACHE_ARCHIVE_SHA256 =
  'b8514ed7552e148b0a032114f745118dcb801791adafafeaf9935e4bfb0edf1b';
export const WINDOWS_SCCACHE_EXECUTABLE_SHA256 =
  '9209ba7cc02278065b6795484228d8dda7125dd72f4a682a215fde0c195a4e0b';
export const WINDOWS_SCCACHE_TOOL_CONTRACT = 'kungfu-windows-sccache-tool/v1';
export const WINDOWS_SCCACHE_DIR =
  '.buildchain/cache/compiler/windows-sccache-v1';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')}`;
}

function appendEnvironment(filePath, values) {
  if (!filePath)
    throw new Error('GITHUB_ENV is required for Windows sccache qualification');
  for (const [name, value] of Object.entries(values)) {
    if (/[\r\n\0]/u.test(String(value)))
      throw new Error(`${name} contains control characters`);
  }
  fs.appendFileSync(
    filePath,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
  );
}

async function defaultDownloadArchive(url, outputPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body)
    throw new Error(`sccache archive download failed: HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(outputPath),
  );
}

function defaultExtractArchive(archivePath, destinationPath, env) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:KUNGFU_SCCACHE_ARCHIVE -DestinationPath $env:KUNGFU_SCCACHE_EXTRACT -Force',
    ],
    {
      env: {
        ...env,
        KUNGFU_SCCACHE_ARCHIVE: archivePath,
        KUNGFU_SCCACHE_EXTRACT: destinationPath,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `sccache archive extraction failed: ${
        result.error?.code ||
        result.error?.message ||
        result.stderr?.trim() ||
        result.status
      }`,
    );
}

function findFile(directory, name) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
      return candidate;
    if (entry.isDirectory()) {
      const nested = findFile(candidate, name);
      if (nested) return nested;
    }
  }
  return '';
}

function defaultRunCommand(command, args, env) {
  return spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function assertToolVersion(executable, expectedVersion, env, runCommand) {
  const result = runCommand(executable, ['--version'], env);
  if (result.error || result.status !== 0)
    throw new Error(
      `sccache version probe failed: ${
        result.error?.code ||
        result.error?.message ||
        result.stderr?.trim() ||
        result.status
      }`,
    );
  const version = String(result.stdout || '')
    .trim()
    .split(/\r?\n/u, 1)[0];
  if (version !== `sccache ${expectedVersion}`)
    throw new Error(
      `sccache version mismatch: expected sccache ${expectedVersion}, got ${version || 'empty'}`,
    );
  return version;
}

export async function ensureWindowsSccache({
  cwd = ROOT,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  downloadArchive = defaultDownloadArchive,
  extractArchive = defaultExtractArchive,
  runCommand = defaultRunCommand,
  now = () => new Date(),
  expectedArchiveSha256 = WINDOWS_SCCACHE_ARCHIVE_SHA256,
  expectedExecutableSha256 = WINDOWS_SCCACHE_EXECUTABLE_SHA256,
} = {}) {
  const provider = String(
    env.BUILDCHAIN_COMPILER_CACHE_PROVIDER || 'none',
  ).toLowerCase();
  if (platform !== 'win32' || provider !== 'sccache')
    return { status: 'not-applicable', provider };
  if (arch !== 'x64')
    throw new Error(`Windows sccache qualification requires x64, got ${arch}`);
  if (!env.GITHUB_PATH)
    throw new Error(
      'GITHUB_PATH is required for Windows sccache qualification',
    );

  const cacheRoot = path.resolve(
    env.KUNGFU_SCCACHE_TOOL_CACHE ||
      path.join(
        homedir,
        '.cache',
        'kungfu',
        'tools',
        'sccache',
        WINDOWS_SCCACHE_VERSION,
        WINDOWS_SCCACHE_TARGET,
      ),
  );
  const executable = path.join(cacheRoot, 'sccache.exe');
  let reused = false;
  if (fs.existsSync(executable)) {
    const actual = sha256File(executable);
    if (actual !== expectedExecutableSha256)
      throw new Error(
        `cached sccache executable digest mismatch: expected ${expectedExecutableSha256}, got ${actual}`,
      );
    reused = true;
  } else {
    if (fs.existsSync(cacheRoot))
      throw new Error(
        `incomplete sccache tool cache exists without sccache.exe: ${cacheRoot}`,
      );
    const parent = path.dirname(cacheRoot);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(parent, '.sccache-install-'));
    try {
      const archivePath = path.join(temporary, 'sccache.zip');
      const extractPath = path.join(temporary, 'extract');
      const stagedTool = path.join(temporary, 'tool');
      await downloadArchive(WINDOWS_SCCACHE_ARCHIVE_URL, archivePath);
      const archiveDigest = sha256File(archivePath);
      if (archiveDigest !== expectedArchiveSha256)
        throw new Error(
          `sccache archive digest mismatch: expected ${expectedArchiveSha256}, got ${archiveDigest}`,
        );
      fs.mkdirSync(extractPath, { recursive: true });
      extractArchive(archivePath, extractPath, env);
      const extractedExecutable = findFile(extractPath, 'sccache.exe');
      if (!extractedExecutable)
        throw new Error('sccache archive did not contain sccache.exe');
      const executableDigest = sha256File(extractedExecutable);
      if (executableDigest !== expectedExecutableSha256)
        throw new Error(
          `sccache executable digest mismatch: expected ${expectedExecutableSha256}, got ${executableDigest}`,
        );
      fs.mkdirSync(stagedTool);
      fs.copyFileSync(
        extractedExecutable,
        path.join(stagedTool, 'sccache.exe'),
      );
      fs.renameSync(stagedTool, cacheRoot);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  const version = assertToolVersion(
    executable,
    WINDOWS_SCCACHE_VERSION,
    env,
    runCommand,
  );
  const toolIdentity = {
    version: WINDOWS_SCCACHE_VERSION,
    target: WINDOWS_SCCACHE_TARGET,
    archive: {
      url: WINDOWS_SCCACHE_ARCHIVE_URL,
      sha256: expectedArchiveSha256,
    },
    executable: {
      name: 'sccache.exe',
      sha256: expectedExecutableSha256,
    },
  };
  const toolRoot = digest(toolIdentity);
  const body = {
    schemaVersion: 1,
    contract: WINDOWS_SCCACHE_TOOL_CONTRACT,
    generatedAt: now().toISOString(),
    status: 'ready',
    provider: 'sccache',
    reused,
    version,
    platform: {
      id: env.BUILDCHAIN_PLATFORM_ID || 'windows-x64',
      os: env.RUNNER_OS || 'Windows',
      arch: env.RUNNER_ARCH || 'X64',
    },
    source: toolIdentity,
    toolRoot,
    bindings: {
      sourceCommit: env.BUILDCHAIN_SOURCE_SHA || env.GITHUB_SHA || '',
      cacheDirectory: WINDOWS_SCCACHE_DIR,
    },
  };
  const receipt = { ...body, root: digest(body) };
  const evidencePath = path.resolve(
    cwd,
    '.buildchain/diagnostics/sccache-tool.json',
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.appendFileSync(env.GITHUB_PATH, `${cacheRoot}\n`);
  appendEnvironment(env.GITHUB_ENV, {
    BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT: receipt.root,
    BUILDCHAIN_COMPILER_CACHE_TOOL_EVIDENCE_PATH: evidencePath,
    KUNGFU_WINDOWS_ALPHA_SCCACHE_DIR: WINDOWS_SCCACHE_DIR,
    SCCACHE_DIR: WINDOWS_SCCACHE_DIR,
  });
  return receipt;
}

async function main() {
  const result = await ensureWindowsSccache();
  if (result.status === 'not-applicable') {
    console.log(
      `[windows-sccache] skipped: platform=${process.platform} provider=${result.provider}`,
    );
    return;
  }
  console.log(`[windows-sccache] version=${result.version}`);
  console.log(`[windows-sccache] reused=${result.reused}`);
  console.log(`[windows-sccache] evidence_root=${result.root}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[windows-sccache] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
