// SPDX-License-Identifier: Apache-2.0
// @ts-check

const libnode = require('@kungfu-tech/libnode');
const fs = require('fs');
const fse = require('fs-extra');
const glob = require('glob');
const path = require('path');
const { shell } = require('../lib');

function main() {
  // build_type is always provided via npm/pnpm package config when these build
  // scripts run; assert string so path.join accepts it (getConfigValue reads
  // process.env, whose type is string | undefined).
  const buildType = /** @type {string} */ (shell.getConfigValue('build_type'));
  glob
    .sync('*.*', { cwd: libnode.libpath })
    .forEach((/** @type {string} */ p) => {
      const src = path.join(libnode.libpath, p);
      const dst = path.join('build', buildType, path.basename(p));
      if (fs.lstatSync(src).isFile()) {
        console.log(`$ cp ${src} ${dst}`);
        fse.copySync(src, dst, { overwrite: true });
      }
    });
}

module.exports.main = main;

if (require.main === module) main();
