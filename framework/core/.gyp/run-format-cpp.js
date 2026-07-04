// SPDX-License-Identifier: Apache-2.0
// @ts-check

const glob = require('glob');
const path = require('path');
const { shell } = require('../lib');

/** @param {string[]} argv */
function main(argv) {
  const cwd = process.cwd().toString();
  process.chdir(path.dirname(__dirname));

  // clang-format is pinned in pyproject and provided by the uv venv (same lane as
  // ruff), so C++ formatting is byte-identical across machines instead of relying
  // on the ambient system clang-format. Format every file in one uv invocation to
  // avoid paying the `uv run` startup cost per file.
  const clangFormat = ['run', '--frozen', 'clang-format'];
  shell.run('uv', [...clangFormat, '--version'], true, { tolerant: true });

  const files = argv.flatMap((/** @type {string} */ dir) =>
    glob
      .sync('**/*.@(h|hpp|hxx|cpp|c|cc|cxx)', { cwd: path.join(cwd, dir) })
      .map((/** @type {string} */ p) => path.join(cwd, dir, p)),
  );
  if (files.length) {
    shell.run('uv', [...clangFormat, '-style=file', '-i', ...files]);
  }
}

module.exports.main = main;

if (require.main === module) {
  main(process.argv.slice(2));
}
