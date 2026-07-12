// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('../lib');

/** @param {string[]} cmd */
function conan(cmd) {
  // uv 接管 env（S1 阶段 A）：在 uv 项目 venv 中运行全局 conan2；--frozen 不偷改 uv.lock。
  const uv_args = ['run', '--frozen', 'conan', ...cmd];
  shell.run('uv', uv_args, true, {
    env: { NODE_GYP_RUN: 'on', ...process.env },
  });
}

function ensureBuildchainConanProfile() {
  if (process.env.KUNGFU_BUILDCHAIN_SOURCE_BUILD !== '1') {
    return;
  }
  const env = { NODE_GYP_RUN: 'on', ...process.env };
  const existing = shell.runAndCollect(
    'uv',
    ['run', '--frozen', 'conan', 'profile', 'path', 'default'],
    { env, silent: true },
  );
  if (existing.status === 0) {
    return;
  }
  shell.run(
    'uv',
    ['run', '--frozen', 'conan', 'profile', 'detect', '--force'],
    true,
    {
      env,
    },
  );
}

// GCC 14 correctly rejects two assignment operators in RxCpp 4.1.1 that
// write through const data members. ConanCenter marks the release unsupported
// on GCC 14, but Kungfu's production compiler floor is newer than that legacy
// header. Export our source-patched recipe before resolution so every host and
// clean cache builds the same audited package revision instead of mutating a
// shared Conan cache after installation.
function ensureKungfuConanRecipes() {
  const source = path.join(__dirname, '..', '.conan', 'recipes', 'rxcpp');
  const recipe = fse.mkdtempSync(path.join(os.tmpdir(), 'kungfu-rxcpp-'));
  try {
    fse.copySync(source, recipe);
    for (const relative of [
      'conanfile.py',
      'conandata.yml',
      path.join('patches', '0001-fix-notification-assignment.patch'),
    ]) {
      const file = path.join(recipe, relative);
      fse.writeFileSync(
        file,
        fse.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
      );
    }
    conan(['export', recipe, '--version', '4.1.1']);
  } finally {
    fse.removeSync(recipe);
  }
}

function getNodeVersionOptions() {
  const packageJson = fse.readJsonSync(
    path.resolve(path.dirname(__dirname), 'package.json'),
  );
  // electron 从 devDependencies 读并去掉 ^/~ 前缀；node_version 从 config 读
  // (v4 起 @kungfu-tech/libnode 不再列为 devDep，dev 走 npm link，见 docs/conan2-migration.md)。
  const electronVersion = String(packageJson.devDependencies.electron).replace(
    /^[\^~]/,
    '',
  );
  const nodeVersion = packageJson.config.node_version;
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
  return names.flatMap(makeConanSetting);
}

// ADR-0063: Conan package identity and the CMake language mode are one
// contract. A dependency binary resolved as gnu17/17 must not share the cache
// key of Kungfu's strict C++23 build merely because most current dependencies
// happen to be header-only or C ABI.
function platformConanSettings() {
  return ['-s', 'compiler.cppstd=23'];
}

/** @param {string} name */
function makeConanOption(name) {
  return ['-o', `${name}=${shell.getConfigValue(name)}`];
}

/** @param {string[]} names */
function makeConanOptions(names) {
  return names.flatMap(makeConanOption).concat(getNodeVersionOptions());
}

// conan2：-if/-bf → --output-folder；arch 是 setting 由 profile 自测，不再作 -o 选项。
// freezer 不再透传给 conan：freeze 已迁出 conan（Stage C → run-freeze.js），
// conanfile 的 freezer option 只喂 conan2 下不可达的遗留 package() 路径；产品
// 形态选择（含 macOS 平台默认 assemble）完全由 run-freeze.js 决定。
function conanInstall() {
  ensureBuildchainConanProfile();
  ensureKungfuConanRecipes();
  const settings = [
    ...makeConanSettings(['build_type']),
    ...platformConanSettings(),
  ];
  const options = makeConanOptions(['log_level']);
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
  const options = makeConanOptions(['log_level']);
  conan(['build', '.', '--output-folder', 'build', ...settings, ...options]);
}

// conan2 移除了独立的 `conan package` 本地命令(package() 经 conan create/export-pkg 触发)。
// Stage C 决定 freeze 脱离 conan：kfc 的 freeze→dist/kungfu 已迁到独立入口 `.gyp/run-freeze.js`
// (pnpm freeze → ./shifu freeze)，见 docs/conan2-migration.md。此处 `package` 子命令
// 仅保留 conan build(编译)语义，不再承担 freeze。
function conanPackage() {
  const settings = [
    ...makeConanSettings(['build_type']),
    ...platformConanSettings(),
  ];
  const options = makeConanOptions(['log_level']);
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
module.exports.conanInstall = conanInstall;
module.exports.conanBuild = conanBuild;

if (require.main === module) main().catch(shell.utils.exitOnError);
