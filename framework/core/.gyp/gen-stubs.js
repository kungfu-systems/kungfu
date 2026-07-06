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
  for (const rel of glob.sync('**/*.pyi', { cwd: 'stubs/pykungfu' })) {
    const file = path.join('stubs', 'pykungfu', rel);
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/\bfrom:/g, 'from_:');
    if (after !== before) fs.writeFileSync(file, after);
  }
}

module.exports = { main };
