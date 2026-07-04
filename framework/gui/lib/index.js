'use strict';
// @ts-check

// Build/dev entry points for the kungfu reference app, kept so the developer/sdk
// `craft` flow (`require('@kungfu-tech/gui').electronBuild / .devRun`)
// keeps resolving after the Vue/webpack -> electron-vite reborn.
//
// NOTE: generic product/extension packaging (the galaxy build that builds an
// arbitrary app dir) is part of the class-D toolchain reborn and is not yet
// reimplemented over electron-vite. These wrappers drive the reference app's own
// electron-vite + electron-builder pipeline.
const path = require('path');
const { spawn } = require('child_process');

const appDir = path.join(__dirname, '..');

/**
 * Spawn a locally-installed bin (from the app's node_modules/.bin), inheriting
 * stdio; resolve on exit code 0, reject otherwise.
 * @param {string} bin
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runBin(bin, args) {
  return new Promise((resolve, reject) => {
    const binPath = path.join(
      appDir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${bin}.cmd` : bin,
    );
    const child = spawn(binPath, args, {
      cwd: appDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with ${code}`)),
    );
    child.on('error', reject);
  });
}

const electronBuild = () =>
  runBin('electron-vite', ['build']).then(() =>
    runBin('electron-builder', [
      '--config.electronDist=node_modules/electron/dist',
    ]),
  );

const devRun = () => runBin('electron-vite', ['dev']);

module.exports = {
  electronBuild,
  devRun,
  defaultDistDir: path.join(appDir, 'out'),
};
