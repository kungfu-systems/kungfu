// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fse = require('fs-extra');
const path = require('path');
const { shell } = require('../lib');

/** @param {string[]} cmd */
function conan(cmd) {
  // uv 接管 env（S1 阶段 A）：在 uv 项目 venv 中运行全局 conan2；--frozen 不偷改 uv.lock。
  const uv_args = ['run', '--frozen', 'conan', ...cmd];
  shell.run('uv', uv_args, true, {
    env: { NODE_GYP_RUN: 'on', ...process.env },
  });
}

function getNodeVersionOptions() {
  const packageJson = fse.readJsonSync(
    path.resolve(path.dirname(__dirname), 'package.json'),
  );
  // electron 从 devDependencies 读并去掉 ^/~ 前缀；node_version 从 config 读
  // (v4 起 @kungfu-tech/libnode 不再列为 devDep，dev 走 npm link，见 docs/conan2-migration.md)。
  const electronVersion = String(
    packageJson.devDependencies['electron'],
  ).replace(/^[\^~]/, '');
  const nodeVersion = packageJson.config['node_version'];
  return [
    '-o',
    `electron_version=${electronVersion}`,
    '-o',
    `node_version=${nodeVersion}`,
    '-o',
    'with_yarn=True',
  ];
}

/** @param {string} name */
function makeConanSetting(name) {
  return ['-s', `${name}=${shell.getConfigValue(name)}`];
}

/** @param {string[]} names */
function makeConanSettings(names) {
  return names.map(makeConanSetting).flat();
}

// Windows 端口固化：conan profile detect 在 MSVC 上把 compiler.cppstd 探成 14，
// 但本项目是 C++17，rocksdb 等无 cppstd=14 的 prebuilt(只 17/20/23)，conan install 会失败。
// 显式钉 17 仅在 Windows 加(Mac/Linux profile 本就 gnu17，强制 17 会改 package id 致缓存失效，故不动)。
function platformConanSettings() {
  return process.platform === 'win32' ? ['-s', 'compiler.cppstd=17'] : [];
}

/** @param {string} name */
function makeConanOption(name) {
  return ['-o', `${name}=${shell.getConfigValue(name)}`];
}

/** @param {string[]} names */
function makeConanOptions(names) {
  return names.map(makeConanOption).flat().concat(getNodeVersionOptions());
}

// conan2：-if/-bf → --output-folder；arch 是 setting 由 profile 自测，不再作 -o 选项。
function conanInstall() {
  const settings = [
    ...makeConanSettings(['build_type']),
    ...platformConanSettings(),
  ];
  const options = makeConanOptions(['log_level', 'freezer']);
  conan([
    'install',
    '.',
    '--output-folder',
    'build',
    '--build=missing',
    ...settings,
    ...options,
  ]);
}

function conanBuild() {
  const settings = [
    ...makeConanSettings(['build_type']),
    ...platformConanSettings(),
  ];
  const options = makeConanOptions(['log_level', 'freezer']);
  conan(['build', '.', '--output-folder', 'build', ...settings, ...options]);
}

// conan2 移除了独立的 `conan package` 本地命令(package() 经 conan create/export-pkg 触发)。
// Stage C 决定 freeze 脱离 conan：kfc 的 freeze→dist/kungfu 已迁到独立入口 `.gyp/run-freeze.js`
// (pnpm freeze → ./kungfu-code freeze)，见 docs/conan2-migration.md。此处 `package` 子命令
// 仅保留 conan build(编译)语义，不再承担 freeze。
function conanPackage() {
  const settings = [
    ...makeConanSettings(['build_type']),
    ...platformConanSettings(),
  ];
  const options = makeConanOptions(['log_level', 'freezer']);
  conan(['build', '.', '--output-folder', 'build', ...settings, ...options]);
}

const cli = require('sywac')
  .command('install', {
    run: conanInstall,
  })
  .command('build', {
    run: conanBuild,
  })
  .command('package', {
    run: conanPackage,
  })
  .help('--help')
  .version('--version')
  .showHelpByDefault();

async function main() {
  await cli.parseAndExit();
}

module.exports.cli = cli;
module.exports.main = main;

if (require.main === module) main().catch(shell.utils.exitOnError);
