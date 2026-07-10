#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);

function envPathKey(env) {
  if (process.platform === 'win32' && Object.hasOwn(env, 'Path')) {
    return 'Path';
  }
  return 'PATH';
}

function existingDirs(dirs) {
  return dirs.filter((dir) => dir && fs.existsSync(dir));
}

function windowsUserToolPathDirs() {
  const usersRoot = 'C:\\Users';
  if (!fs.existsSync(usersRoot)) {
    return [];
  }
  return fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const home = path.join(usersRoot, entry.name);
      return [
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
        path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, 'scoop', 'shims'),
      ];
    });
}

function findExecutableDirs(roots, executableNames, options = {}) {
  const maxDepth = options.maxDepth ?? 4;
  const maxMatches = options.maxMatches ?? 16;
  const matches = new Set();
  const wanted = new Set(executableNames.map((name) => name.toLowerCase()));
  const skipDirs = new Set([
    '.git',
    'node_modules',
    'Package Cache',
    'Temp',
    'tmp',
  ]);
  const queue = roots
    .filter((root) => root && fs.existsSync(root))
    .map((root) => ({ dir: root, depth: 0 }));

  while (queue.length && matches.size < maxMatches) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) {
        matches.add(dir);
        if (matches.size >= maxMatches) break;
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !skipDirs.has(entry.name)
      ) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return [...matches];
}

function windowsToolPathDirs(env) {
  if (process.platform !== 'win32') {
    return [];
  }
  const home = env.USERPROFILE || env.HOME;
  const localAppData = env.LOCALAPPDATA;
  const candidateDirs = [
    localAppData && path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    localAppData && path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
    home && path.join(home, '.local', 'bin'),
    home && path.join(home, '.cargo', 'bin'),
    home && path.join(home, 'scoop', 'shims'),
    ...windowsUserToolPathDirs(),
  ];
  return [
    ...existingDirs(candidateDirs),
    ...findExecutableDirs(candidateDirs, ['uv.exe', 'uvx.exe']),
  ];
}

function withPathPrefixes(env, dirs) {
  const pathKey = envPathKey(env);
  return {
    ...env,
    [pathKey]: [...dirs, env[pathKey] || env.PATH || env.Path || '']
      .filter(Boolean)
      .join(path.delimiter),
  };
}

function withWindowsFnmDir(env) {
  if (process.platform !== 'win32' || env.FNM_DIR) {
    return env;
  }
  return {
    ...env,
    FNM_DIR: path.join(repoRoot, '.buildchain', 'fnm'),
  };
}

function commandAvailable(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function powershellCommand() {
  for (const command of ['pwsh.exe', 'powershell.exe']) {
    if (
      commandAvailable(
        command,
        ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        process.env,
      )
    ) {
      return command;
    }
  }
  return '';
}

function psSingleQuoted(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function runAndCollect(command, args, env) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

function windowsProgramFilesRoots(env) {
  return [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter((dir, index, dirs) => dir && dirs.indexOf(dir) === index);
}

function windowsVisualStudioRoots(env) {
  return windowsProgramFilesRoots(env).map((root) =>
    path.join(root, 'Microsoft Visual Studio'),
  );
}

function windowsVswhereCandidates(env) {
  return windowsProgramFilesRoots(env)
    .map((root) =>
      path.join(root, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    )
    .filter(
      (candidate, index, candidates) =>
        candidate && candidates.indexOf(candidate) === index,
    );
}

function findFilesByName(roots, fileName, options = {}) {
  const maxDepth = options.maxDepth ?? 5;
  const maxMatches = options.maxMatches ?? 8;
  const matches = [];
  const wanted = fileName.toLowerCase();
  const queue = roots
    .filter((root) => root && fs.existsSync(root))
    .map((root) => ({ dir: root, depth: 0 }));

  while (queue.length && matches.length < maxMatches) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        matches.push(fullPath);
        if (matches.length >= maxMatches) break;
      } else if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return matches;
}

function windowsVcvarsCandidates(env) {
  if (process.platform !== 'win32') {
    return [];
  }
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  const vsInstallDir = env.VSINSTALLDIR;
  add(
    vsInstallDir &&
      path.join(vsInstallDir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'),
  );

  for (const vswhere of windowsVswhereCandidates(env)) {
    if (!fs.existsSync(vswhere)) continue;
    const result = runAndCollect(
      vswhere,
      [
        '-latest',
        '-products',
        '*',
        '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property',
        'installationPath',
      ],
      env,
    );
    if (result.status === 0) {
      for (const line of result.stdout.split(/\r?\n/)) {
        add(path.join(line.trim(), 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'));
      }
    }
  }

  for (const root of windowsVisualStudioRoots(env)) {
    for (const vcvars of findFilesByName([root], 'vcvars64.bat')) {
      add(vcvars);
    }
  }

  return candidates.filter((candidate) => fs.existsSync(candidate));
}

function parseWindowsSetOutput(stdout) {
  const env = {};
  for (const line of stdout.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function windowsMsvcAvailable(env) {
  return (
    process.platform === 'win32' && commandAvailable('where.exe', ['cl'], env)
  );
}

function ensureWindowsMsvcEnv(env) {
  if (process.platform !== 'win32' || windowsMsvcAvailable(env)) {
    return env;
  }

  const vcvars = windowsVcvarsCandidates(env)[0];
  if (!vcvars) {
    throw new Error(
      'MSVC cl.exe not found in PATH and vcvars64.bat could not be located',
    );
  }

  console.error(`[buildchain-run] cl.exe not found; loading ${vcvars}`);
  const result = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', `""${vcvars}" x64 >nul && set"`],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsVerbatimArguments: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `MSVC environment bootstrap failed with exit ${result.status ?? 'signal'}`,
    );
  }

  const nextEnv = { ...env, ...parseWindowsSetOutput(result.stdout) };
  if (!windowsMsvcAvailable(nextEnv)) {
    throw new Error(
      'MSVC environment bootstrap did not produce cl.exe in PATH',
    );
  }
  return nextEnv;
}

function ensureWindowsUv(env) {
  if (
    process.platform !== 'win32' ||
    commandAvailable('uv', ['--version'], env)
  ) {
    return env;
  }

  const installDir = path.join(repoRoot, '.buildchain', 'uv');
  fs.mkdirSync(installDir, { recursive: true });
  const ps = powershellCommand();
  if (!ps) {
    throw new Error(
      'uv not found and PowerShell is unavailable to bootstrap it',
    );
  }

  console.error(`[buildchain-run] uv not found; installing to ${installDir}`);
  const result = spawnSync(
    ps,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        `$env:UV_INSTALL_DIR = ${psSingleQuoted(installDir)}`,
        "$env:UV_UNMANAGED_INSTALL = '1'",
        'irm https://astral.sh/uv/install.ps1 | iex',
      ].join('; '),
    ],
    {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `uv bootstrap failed with exit ${result.status ?? 'signal'}`,
    );
  }

  const nextEnv = withPathPrefixes(env, [installDir]);
  if (!commandAvailable('uv', ['--version'], nextEnv)) {
    throw new Error(
      `uv bootstrap did not produce a runnable uv in ${installDir}`,
    );
  }
  return nextEnv;
}

function createPnpmShimDir() {
  const shimDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-buildchain-pnpm-'),
  );

  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(shimDir, 'pnpm.cmd'),
      '@echo off\r\ncorepack.cmd pnpm %*\r\n',
      'utf8',
    );
  } else {
    const shimPath = path.join(shimDir, 'pnpm');
    fs.writeFileSync(shimPath, '#!/bin/sh\nexec corepack pnpm "$@"\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
  }

  return shimDir;
}

function createWindowsNodeShimDir(nodeExe) {
  const shimDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-buildchain-node-'),
  );
  const escapedNodeExe = nodeExe.replace(/%/g, '%%');
  fs.writeFileSync(
    path.join(shimDir, 'node.cmd'),
    `@echo off\r\n"${escapedNodeExe}" %*\r\n`,
    'utf8',
  );
  return shimDir;
}

function pinnedNodeVersion() {
  try {
    return fs
      .readFileSync(path.join(repoRoot, '.node-version'), 'utf8')
      .trim()
      .replace(/^v/, '');
  } catch {
    return '';
  }
}

function windowsFnmRoots(env) {
  if (process.platform !== 'win32') {
    return [];
  }

  const home = env.USERPROFILE || env.HOME;
  const roots = [
    env.FNM_DIR,
    env.APPDATA && path.join(env.APPDATA, 'fnm'),
    home && path.join(home, 'AppData', 'Roaming', 'fnm'),
  ];
  const usersRoot = 'C:\\Users';
  if (fs.existsSync(usersRoot)) {
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(
          path.join(usersRoot, entry.name, 'AppData', 'Roaming', 'fnm'),
        );
      }
    }
  }

  return roots.filter((root, index) => root && roots.indexOf(root) === index);
}

function findWindowsPinnedNode(env) {
  const version = pinnedNodeVersion();
  if (process.platform !== 'win32' || !version) {
    return '';
  }

  const versions = [version, `v${version}`];
  for (const root of windowsFnmRoots(env)) {
    for (const candidateVersion of versions) {
      const candidate = path.join(
        root,
        'node-versions',
        candidateVersion,
        'installation',
        'node.exe',
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function installWindowsNodeFromDist(env) {
  const version = pinnedNodeVersion();
  if (process.platform !== 'win32' || !version) {
    return '';
  }

  const nodeDirName = `node-v${version}-win-x64`;
  const installParent = path.join(repoRoot, '.buildchain', 'node');
  const installDir = path.join(installParent, nodeDirName);
  const nodeExe = path.join(installDir, 'node.exe');
  if (fs.existsSync(nodeExe)) {
    return nodeExe;
  }

  const ps = powershellCommand();
  if (!ps) {
    return '';
  }

  const downloadDir = path.join(repoRoot, '.buildchain', 'downloads');
  const zipName = `${nodeDirName}.zip`;
  const zipPath = path.join(downloadDir, zipName);
  const baseUrl = (
    env.FNM_NODE_DIST_MIRROR ||
    env.NODEJS_ORG_MIRROR ||
    'https://nodejs.org/dist'
  ).replace(/\/+$/, '');
  const url = `${baseUrl}/v${version}/${zipName}`;

  console.error(
    `[buildchain-run] downloading pinned Node ${version} to ${installDir}`,
  );
  const result = spawnSync(
    ps,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        `New-Item -ItemType Directory -Force ${psSingleQuoted(downloadDir)} | Out-Null`,
        `New-Item -ItemType Directory -Force ${psSingleQuoted(installParent)} | Out-Null`,
        `if (-not (Test-Path ${psSingleQuoted(zipPath)})) { Invoke-WebRequest -Uri ${psSingleQuoted(url)} -OutFile ${psSingleQuoted(zipPath)} }`,
        `Expand-Archive -Path ${psSingleQuoted(zipPath)} -DestinationPath ${psSingleQuoted(installParent)} -Force`,
      ].join('; '),
    ],
    {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    return '';
  }
  return fs.existsSync(nodeExe) ? nodeExe : '';
}

function resolveWindowsPinnedNode(env) {
  if (process.platform !== 'win32') {
    return '';
  }

  const existingNode = findWindowsPinnedNode(env);
  if (existingNode) {
    return existingNode;
  }

  if (!commandAvailable('fnm', ['--version'], env)) {
    return installWindowsNodeFromDist(env);
  }

  spawnSync('fnm', ['install'], {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    shell: true,
  });

  const result = runAndCollect(
    'fnm',
    ['exec', '--', 'node', '-p', 'process.execPath'],
    env,
  );
  if (result.status !== 0) {
    return '';
  }

  const nodeExe = result.stdout.trim().split(/\r?\n/).pop()?.trim() || '';
  if (nodeExe && fs.existsSync(nodeExe)) {
    return nodeExe;
  }
  return findWindowsPinnedNode(env) || installWindowsNodeFromDist(env);
}

function corepackJsForNode(nodeExe) {
  const corepackJs = path.join(
    path.dirname(nodeExe),
    'node_modules',
    'corepack',
    'dist',
    'corepack.js',
  );
  return fs.existsSync(corepackJs) ? corepackJs : '';
}

function runWindowsPnpm(args, env, pinnedNode) {
  const corepackJs = pinnedNode ? corepackJsForNode(pinnedNode) : '';
  if (corepackJs) {
    return spawnSync(pinnedNode, [corepackJs, 'pnpm', ...args], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
  }

  if (commandAvailable('fnm', ['--version'], env)) {
    spawnSync('fnm', ['install'], {
      cwd: repoRoot,
      env,
      stdio: 'ignore',
      shell: true,
    });
    return spawnSync('fnm', ['exec', '--', 'corepack.cmd', 'pnpm', ...args], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
      shell: true,
    });
  }

  return spawnSync('corepack.cmd', ['pnpm', ...args], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: true,
  });
}

let env = withPathPrefixes(process.env, [
  createPnpmShimDir(),
  ...windowsToolPathDirs(process.env),
]);
env = withWindowsFnmDir(env);
const pinnedWindowsNode = resolveWindowsPinnedNode(env);
if (process.platform === 'win32' && !pinnedWindowsNode) {
  console.error(
    `[buildchain-run] pinned Node ${pinnedNodeVersion() || '(unknown)'} not found; install fnm or run fnm install before buildchain lifecycle`,
  );
  process.exit(1);
}
if (pinnedWindowsNode) {
  console.error(`[buildchain-run] using pinned Node ${pinnedWindowsNode}`);
  env = withPathPrefixes(
    {
      ...env,
      npm_node_execpath: pinnedWindowsNode,
      NODE: pinnedWindowsNode,
    },
    [
      createWindowsNodeShimDir(pinnedWindowsNode),
      path.dirname(pinnedWindowsNode),
    ],
  );
}
env = ensureWindowsUv(env);
env = ensureWindowsMsvcEnv(env);
env.KUNGFU_BUILDCHAIN_NO_OPTIONAL = '1';
env.KUNGFU_BUILDCHAIN_SOURCE_BUILD = '1';
const result =
  process.platform === 'win32'
    ? runWindowsPnpm(argv, env, pinnedWindowsNode)
    : spawnSync(path.join(repoRoot, 'shifu'), argv, {
        cwd: repoRoot,
        env,
        stdio: 'inherit',
      });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error(`shifu terminated by signal ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 0);
