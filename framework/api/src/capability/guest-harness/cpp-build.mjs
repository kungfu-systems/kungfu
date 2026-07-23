// SPDX-License-Identifier: Apache-2.0
//
// Compile a C++ guest fixture into a runnable binary for the guest-harness. A
// C++ service ships a PREBUILT per-platform binary (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): there is no
// interpreter to load a source entry, so the harness mirrors what a kfx author's
// build does — resolve the one dependency the guest proxy needs (nlohmann/json,
// pinned by framework/core/conanfile.py and provided by conan) and invoke the
// platform C++ compiler once. The produced binary links guest.hpp and the
// fixture body into a single image the host launches directly, with no bootstrap
// wrapper — exactly how resolveServiceRuntime lands a cpp service in production.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// framework/api/src/capability/guest-harness → framework/core/src/capability
const CORE_CAPABILITY = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'core',
  'src',
  'capability',
);
const CORE_CONANFILE = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'core',
  'conanfile.py',
);

// The pinned nlohmann_json version, single source of truth: core/conanfile.py.
function nlohmannVersion() {
  const m = readFileSync(CORE_CONANFILE, 'utf8').match(
    /nlohmann_json\/([\d.]+)/,
  );
  if (!m) {
    throw new Error('cannot find nlohmann_json version in core/conanfile.py');
  }
  return m[1];
}

// Resolve the nlohmann/json include dir via conan (the header is already in the
// conan cache once core has been configured; this only reads the graph).
function nlohmannInclude() {
  const version = nlohmannVersion();
  // Run conan in a throwaway dir: `conan install` writes activation-script
  // generators (conanbuild.sh, conanrun.sh, …) into its cwd, which must not leak
  // into the source tree. Only the JSON graph on stdout is used.
  const scratch = mkdtempSync(join(tmpdir(), 'kfx-conan-'));
  let r;
  try {
    r = spawnSync(
      'conan',
      ['install', `--requires=nlohmann_json/${version}`, '--format=json'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: scratch },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (r.status !== 0) {
    throw new Error(
      `conan install nlohmann_json/${version} failed:\n${r.stderr || r.stdout}`,
    );
  }
  const graph = JSON.parse(r.stdout);
  for (const node of Object.values(graph.graph.nodes)) {
    if (node.name === 'nlohmann_json' && node.package_folder) {
      const inc = join(node.package_folder, 'include');
      if (existsSync(inc)) return inc;
    }
  }
  throw new Error(
    'nlohmann_json include dir not resolved from the conan graph',
  );
}

// Returns true when a C++ toolchain and conan are both reachable, so a caller
// can skip (not fail) the cpp cell in an environment that cannot build it.
export function cppBuildAvailable() {
  const isWin = process.platform === 'win32';
  const cxx = process.env.CXX || (isWin ? 'cl' : 'c++');
  const probe = isWin ? 'where' : 'command';
  const args = isWin ? [cxx] : ['-v', cxx];
  const hasCxx = spawnSync(probe, args, { stdio: 'ignore' }).status === 0;
  const hasConan =
    spawnSync(
      isWin ? 'where' : 'command',
      isWin ? ['conan'] : ['-v', 'conan'],
      {
        stdio: 'ignore',
      },
    ).status === 0;
  return hasCxx && hasConan;
}

// Compile `sourceFile` (a C++ guest fixture that includes guest.hpp) into
// `outFile`. nlohmann is passed with -isystem so its own deprecation warnings do
// not drown the fixture's; guest.hpp is a plain -I include.
export function buildCppGuest(sourceFile, outFile) {
  const inc = nlohmannInclude();
  const isWin = process.platform === 'win32';
  const cxx = process.env.CXX || (isWin ? 'cl' : 'c++');
  const args = isWin
    ? [
        '/std:c++17',
        '/EHsc',
        '/O2',
        '/nologo',
        `/I${CORE_CAPABILITY}`,
        `/I${inc}`,
        sourceFile,
        `/Fe${outFile}`,
      ]
    : [
        '-std=c++17',
        '-O2',
        '-pthread',
        '-I',
        CORE_CAPABILITY,
        '-isystem',
        inc,
        sourceFile,
        '-o',
        outFile,
      ];
  const r = spawnSync(cxx, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`C++ compile failed (${cxx}):\n${r.stderr || r.stdout}`);
  }
  return outFile;
}
