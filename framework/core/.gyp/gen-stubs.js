// SPDX-License-Identifier: Apache-2.0
// @ts-check

// Regenerate the pykungfu .pyi stubs from the freshly compiled binding so the
// committed stubs/ track the C++ binding instead of drifting. Called from
// run-build.js build() AFTER conanBuild() compiles the addon and
// run-link-node.main() colocates libnode into build/<build_type> — that
// colocation is what lets `import pykungfu` resolve @rpath/libnode here.
//
// The type-check / verify env does not compile the native binding; it consumes
// these committed text stubs (mypy_path = "stubs"). So this step keeps the two
// in sync: build regenerates, the developer commits the diff, and CI can add
// `git diff --exit-code stubs/` to reject a binding change that forgot to
// regenerate. Fast (~1s over the already-built binding), and only runs when the
// native addon is actually rebuilt.

const fs = require('node:fs');
const path = require('node:path');
const glob = require('glob');
const { shell } = require('../lib');

function main() {
  const buildType = shell.getConfigValue('build_type') || 'Release';
  const buildDir = path.resolve('build', buildType);

  // Windows: the MSVC multi-config generator emits pykungfu.<abi>.pyd into build/
  // root while libnode.dll lands in build/<build_type>. pybind11-stubgen imports
  // pykungfu, so the .pyd must be on PYTHONPATH *and* able to load libnode.dll —
  // and Python 3.8+ resolves an extension's dependent DLLs from the extension's
  // own directory, not PATH. So colocate the .pyd next to libnode.dll in
  // build/<build_type>; then PYTHONPATH=build/<build_type> both imports it and
  // resolves the DLL. Mac/Linux keep the .so in build/<build_type> with rpath, so
  // this is a no-op there. (run-freeze.js colocates the same way for the frozen
  // runtime; without it stubgen fails with ModuleNotFoundError: pykungfu.)
  if (process.platform === 'win32') {
    const buildRoot = path.resolve('build');
    const [pyd] = glob.sync('pykungfu*.pyd', { cwd: buildRoot });
    if (pyd) {
      fs.copyFileSync(path.join(buildRoot, pyd), path.join(buildDir, pyd));
    } else {
      console.error('[gen-stubs] Win: pykungfu*.pyd not found in build/ root');
    }
  }

  // pybind11-stubgen imports pykungfu from build/<build_type>; pass PYTHONPATH to
  // the child only (not this process). Runs in the uv venv (pybind11-stubgen dep).
  const prev = process.env.PYTHONPATH;
  const pythonPath = prev ? `${buildDir}${path.delimiter}${prev}` : buildDir;
  shell.run(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      '-m',
      'pybind11_stubgen',
      'pykungfu',
      '-o',
      'stubs',
    ],
    true,
    { env: { ...process.env, PYTHONPATH: pythonPath } },
  );

  // pybind11-stubgen copies C++ parameter names verbatim; `from` is a Python
  // keyword, so `def f(self, from: int)` is invalid Python — rename to `from_`.
  // It also follows the host newline convention; committed stubs are canonical
  // LF text so a Windows build must not dirty the worktree by line endings alone.
  for (const rel of glob.sync('**/*.pyi', { cwd: 'stubs/pykungfu' })) {
    const file = path.join('stubs', 'pykungfu', rel);
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/\r\n?/g, '\n').replace(/\bfrom:/g, 'from_:');
    if (after !== before) fs.writeFileSync(file, after);
  }
}

module.exports = { main };
