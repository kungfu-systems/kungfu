// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fs = require('fs');
const glob = require('glob');
const path = require('path');
const { prebuilt, shell } = require('../lib');

function cpVsDependencies() {
  const isWin = process.platform === 'win32';
  if (!isWin) return;
  // __dirname=.gyp → 上一级=core 根。用 __dirname 定位 core 目录，不用
  // require.resolve('@kungfu-tech/core/...')：包管理器的隔离式 node_modules 布局
  // 不会把工作区包按自身包名暴露到 node_modules，自引用按包名解析会失败（扁平
  // hoist 布局下才解得到）。与 useUvPython() 用 __dirname 的写法一致。
  const core_dir = path.join(__dirname, '..');
  const vs_dir = path.join(core_dir, '.deps', 'vs');
  const kfc_dist = path.join(core_dir, 'dist', 'kungfu');
  fs.cpSync(vs_dir, kfc_dist, { recursive: true });
}

// Stage the freshly built native artifacts into dist/kungfu, the binding
// directory the runtime resolver (lib/kungfu.js) and the platform-package
// packer (.gyp/core-platform-package.js) consume. This replaces node-pre-gyp's
// implicit module_path staging now that install/build no longer drive it: the
// native addons and their sibling shared libraries move together so the
// addon's @loader_path lookup resolves. libnode is not staged here — it is
// colocated at install time from @kungfu-tech/libnode (see design decision (1)).
function stage() {
  const buildType = shell.getConfigValue('build_type') || 'Release';
  const distKungfu = path.join('dist', 'kungfu');
  fs.rmSync(distKungfu, { recursive: true, force: true });
  fs.mkdirSync(distKungfu, { recursive: true });
  // The CMake addons land in CMAKE_BINARY_DIR, which the conan layout resolves to
  // build/<buildType> on macOS/Linux but build/ on Windows; run-link-node stages
  // the libnode runtime into build/<buildType>. Search both so the staged set is
  // complete on every platform, deduping by basename. Pass the directory via
  // glob's `cwd` instead of embedding it in the pattern — on Windows path.join
  // yields backslashes, which glob treats as escapes and would match nothing.
  // `*.so.*` catches versioned ELF sonames (e.g. libnode.so.127) that pykungfu's
  // DT_NEEDED references; `*.pyd` catches the Windows Python binding, which is a
  // `*.so` on posix.
  const buildDirs = [path.join('build', buildType)];
  if (process.platform === 'win32') buildDirs.push('build');
  const staged = new Set();
  for (const buildDir of buildDirs) {
    for (const pattern of [
      '*.node',
      '*.pyd',
      '*.dylib',
      '*.so',
      '*.so.*',
      '*.dll',
    ]) {
      for (const rel of glob.sync(pattern, { cwd: buildDir })) {
        const base = path.basename(rel);
        if (staged.has(base)) continue;
        staged.add(base);
        fs.copyFileSync(path.join(buildDir, rel), path.join(distKungfu, base));
      }
    }
  }
}

// Build the native addon directly through the real builder (run-conan.js →
// uv/conan2/cmake), not through node-pre-gyp. node-pre-gyp only circled back to
// run-conan.js; calling it in-process removes the host-config detour and lets a
// clean `install` stay a no-op while `build` owns compilation + staging.
// In-process (not a node subprocess) so process.execPath with spaces —
// e.g. Windows `C:\Program Files\nodejs\node.exe` — cannot break the call.
function build() {
  const { conanInstall, conanBuild } = require('./run-conan');
  conanInstall();
  conanBuild();
  // Colocate the libnode runtime into build/<build_type> before staging, so the
  // staged dist/kungfu is self-contained: pykungfu links @rpath/libnode.*, and
  // dist/kungfu is the single runtime surface that kfx and the platform package
  // both depend on. Require lazily (loads @kungfu-tech/libnode) so non-build
  // commands stay light.
  require('./run-link-node').main();
  stage();
  cpVsDependencies();
}

function clean() {
  fs.rmSync('dist', { recursive: true, force: true });
  fs.rmSync('build', { recursive: true, force: true });
}

function makePackage() {
  const prebuilt = glob.sync('build/stage/**/*.tar.gz');
  const wheel = glob.sync('build/python/dist/*.whl');
  const packageDir = path.dirname(prebuilt[0]);
  const wheelFileName = path.basename(wheel[0]);
  console.log(`$ cp ${wheel} ${packageDir}`);
  fs.copyFileSync(wheel[0], path.join(packageDir, wheelFileName));
}

// uv 接管 env（S1 阶段 A）：node-gyp 默认按 PATH 找 python3，可能选到无 distutils 的系统
// python（如 Homebrew python@3.14）→ gyp configure 在 `from distutils...` 处失败。显式把
// node-gyp 的 python 钉到 uv 项目 venv 的 python（setuptools 提供 _distutils shim），根治
// “node native 编译用哪个 python 不确定”的脆弱点。uv 不可用时静默跳过，回退默认查找。
function useUvPython() {
  const isWin = process.platform === 'win32';
  // 直接定位 uv 项目 venv 的 python（__dirname=.gyp → 上一级=core 根 → .venv）。
  // 不解 realpath：venv 的 python 是指向 base python 的 symlink，靠“在 .venv/bin 下”这一
  // 路径语义才会启用 venv site-packages（setuptools 的 _distutils shim）；解到真身就丢了。
  const venvPy = path.join(
    __dirname,
    '..',
    '.venv',
    isWin ? 'Scripts' : 'bin',
    isWin ? 'python.exe' : 'python3',
  );
  if (fs.existsSync(venvPy)) {
    // PYTHON 是 node-gyp findPython 必查项；npm_config_python 双保险。
    process.env.PYTHON = venvPy;
    process.env.npm_config_python = venvPy;
  }
}

/**
 * @param {string[]} args
 * @param {boolean} [check]
 */
function callPrebuilt(args, check = true) {
  useUvPython();
  const buildType = process.env.npm_package_config_build_type;
  const buildTypeOpt = buildType === 'Debug' ? ['--debug'] : [];
  return prebuilt(...buildTypeOpt, ...args);
}

module.exports = require('../lib/sywac')(
  /** @type {NodeModule} */ (module),
  (/** @type {any} */ cli) => {
    cli
      .command('install', () => {
        // 4.0 publishes no prebuilt binary and the self-hosted download host is
        // retired, so build the native addon from source when it is missing (a
        // later install skips the recompile). Set KF_SKIP_INSTALL_BUILD=true to
        // skip when the build runs as an explicit separate step. Prebuilt
        // binaries return later via npm platform packages, not a download.
        if (process.env.KF_SKIP_INSTALL_BUILD === 'true') {
          return;
        }
        const builtAddon = path.join(
          __dirname,
          '..',
          'dist',
          'kungfu',
          'kungfu_node.node',
        );
        if (fs.existsSync(builtAddon)) {
          return;
        }
        build();
      })
      .command('build', () => build())
      .command('clean', () => clean())
      .command('rebuild', () => {
        clean();
        build();
      })
      .command('package', () => {
        callPrebuilt(['package']).onSuccess(makePackage);
      });
  },
);
