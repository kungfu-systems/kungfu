// SPDX-License-Identifier: Apache-2.0

const { shell } = require('../lib');

function main() {
  const tryFormat = (lang) => {
    shell.run('pnpm', ['run', `format:${lang}`], false, { silent: true });
  };
  try {
    tryFormat('cpp');
    tryFormat('python');
    // JS/TS across the whole tree (including core's .gyp/lib) is handled by the
    // root biome config via `pnpm run format:web`; core no longer runs prettier.
  } catch (err) {
    console.error(err);
  }
}

module.exports.main = main;

if (require.main === module) main();
