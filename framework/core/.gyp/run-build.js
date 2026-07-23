// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fs = require('node:fs');
const glob = require('glob');
const path = require('node:path');
const { prebuilt, shell } = require('../lib');

const CORE = path.join(__dirname, '..');
const { copyContractArtifacts } = require(
  path.join(CORE, '..', '..', 'scripts', 'contract-registry.cjs'),
);
const { measureCandidateStageSync } = require(
  path.join(CORE, '..', '..', 'scripts', 'candidate-timeline-events.cjs'),
);
const SDK_BUILD_PLAN = require('../architecture/sdk-build-plan.json');

function selectedBuildBindings() {
  const authority = require('../architecture/build-capabilities.json');
  const profileId =
    process.env.KUNGFU_BUILD_PROFILE ||
    shell.getConfigValue('build_profile') ||
    authority.default_profile;
  const profile = authority.profiles.find(({ id }) => id === profileId);
  if (!profile || profile.status !== 'supported') {
    throw new Error(`unsupported Kungfu Core build profile: ${profileId}`);
  }
  return new Set(profile.bindings);
}

function copyConfigContract() {
  copyContractArtifacts(path.join(CORE, 'dist', 'kungfu'));
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {Set<string>} staged
 */
function copyBuildInfo(sourceDir, targetDir, staged) {
  const source = path.join(sourceDir, 'kungfubuildinfo.json');
  if (!fs.existsSync(source) || staged.has('kungfubuildinfo.json')) return;
  staged.add('kungfubuildinfo.json');
  fs.copyFileSync(source, path.join(targetDir, 'kungfubuildinfo.json'));
}

/**
 * @param {string} sourceDir
 * @param {string} targetDir
 * @param {Set<string>} staged
 */
function copyBuildIdentity(sourceDir, targetDir, staged) {
  const name = 'kungfu-core-build-identity.json';
  const source = path.join(sourceDir, name);
  if (!fs.existsSync(source) || staged.has(name)) return;
  staged.add(name);
  fs.copyFileSync(source, path.join(targetDir, name));
}

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
/**
 * @param {Set<string> | null} [requiredArtifacts]
 */
function stage(requiredArtifacts = null) {
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
  const buildDirs = ['build', path.join('build', buildType)];
  const staged = new Set();
  for (const buildDir of buildDirs) {
    if (!requiredArtifacts || requiredArtifacts.has('kungfubuildinfo.json')) {
      copyBuildInfo(buildDir, distKungfu, staged);
    }
    if (
      !requiredArtifacts ||
      requiredArtifacts.has('kungfu-core-build-identity.json')
    ) {
      copyBuildIdentity(buildDir, distKungfu, staged);
    }
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
        if (requiredArtifacts && !requiredArtifacts.has(base)) continue;
        if (staged.has(base)) continue;
        staged.add(base);
        fs.copyFileSync(path.join(buildDir, rel), path.join(distKungfu, base));
      }
    }
  }
  if (requiredArtifacts) {
    const missing = [...requiredArtifacts].filter((name) => !staged.has(name));
    if (missing.length > 0) {
      throw new Error(
        `SDK Core build omitted required artifacts: ${missing.join(', ')}`,
      );
    }
  }
  copyConfigContract();
}

function sdkRequiredArtifacts() {
  let platformArtifacts;
  switch (process.platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
      platformArtifacts = SDK_BUILD_PLAN.required_artifacts[process.platform];
      break;
    default:
      throw new Error(
        `unsupported SDK Core build platform: ${process.platform}-${process.arch}`,
      );
  }
  return new Set([
    ...SDK_BUILD_PLAN.required_artifacts.common,
    ...platformArtifacts,
  ]);
}

/**
 * @template T
 * @param {string} key
 * @param {string} value
 * @param {() => T} action
 * @returns {T}
 */
function withEnvironment(key, value, action) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

// Build the native addon directly through the real builder (run-conan.js →
// uv/conan2/cmake), not through node-pre-gyp. node-pre-gyp only circled back to
// run-conan.js; calling it in-process removes the host-config detour and lets a
// clean `install` stay a no-op while `build` owns compilation + staging.
// In-process (not a node subprocess) so process.execPath with spaces —
// e.g. Windows `C:\Program Files\nodejs\node.exe` — cannot break the call.
function build(scope = 'full') {
  const bindings = selectedBuildBindings();
  const { conanInstall, conanBuild } = require('./run-conan');
  const sdkBuild = scope === 'sdk';
  if (sdkBuild) {
    const profile =
      process.env.KUNGFU_BUILD_PROFILE ||
      shell.getConfigValue('build_profile') ||
      'full';
    if (profile !== SDK_BUILD_PLAN.profile) {
      throw new Error(
        `SDK Core build requires profile ${SDK_BUILD_PLAN.profile}, got ${profile}`,
      );
    }
    for (const binding of ['cxx', 'c', 'node']) {
      if (!bindings.has(binding)) {
        throw new Error(`SDK Core build profile omits ${binding} binding`);
      }
    }
  } else if (scope !== 'full') {
    throw new Error(`unsupported Core build scope: ${scope}`);
  }
  measureCandidateStageSync(
    'sdk-core-dependencies',
    'core-dependency-bootstrap',
    () =>
      withEnvironment('KUNGFU_CORE_BUILD_SCOPE', scope, () => conanInstall()),
    { gateId: 'source.changed-scope' },
  );
  measureCandidateStageSync(
    'sdk-core-native',
    'core-build',
    () => withEnvironment('KUNGFU_CORE_BUILD_SCOPE', scope, () => conanBuild()),
    {
      gateId: 'source.changed-scope',
    },
  );
  // Colocate the libnode runtime into build/<build_type> before staging, so the
  // staged dist/kungfu is self-contained: pykungfu links @rpath/libnode.*, and
  // dist/kungfu is the single runtime surface that kfx and the platform package
  // both depend on. Require lazily (loads @kungfu-tech/libnode) so non-build
  // commands stay light.
  if (
    !sdkBuild &&
    [...bindings].some((binding) =>
      ['python', 'node', 'electron'].includes(binding),
    )
  ) {
    measureCandidateStageSync(
      'sdk-core-link-node',
      'core-link',
      () => require('./run-link-node').main(),
      { gateId: 'source.changed-scope' },
    );
  }
  // With libnode colocated above, pykungfu imports — regenerate its .pyi stubs
  // from the fresh binding so committed stubs/ track the C++ (see gen-stubs.js).
  if (!sdkBuild && bindings.has('python')) {
    measureCandidateStageSync(
      'sdk-core-python-stubs',
      'sdk-pack-python',
      () => require('./gen-stubs').main(),
      { gateId: 'source.changed-scope', language: 'python' },
    );
  }
  // The pykungfu wheel ships in dist/kungfu/wheels — the product install
  // surface (`kungfu env`) resolves it from there. Build it with the binding
  // so every build/rebuild leaves a wheel matching the fresh natives; before
  // this only the gyp kfc chain built it, and the product dist chain shipped
  // without wheels (run-freeze copyWheel warned but could not fail).
  // run-wheel.js ends with process.exit, so spawn it instead of requiring.
  if (!sdkBuild && bindings.has('python')) {
    measureCandidateStageSync(
      'sdk-core-python-wheel',
      'sdk-pack-python',
      () =>
        shell.run(
          process.execPath,
          [path.join(__dirname, 'run-wheel.js')],
          true,
        ),
      { gateId: 'source.changed-scope', language: 'python' },
    );
  }
  measureCandidateStageSync(
    'sdk-core-stage',
    'sdk-pack-native',
    () => stage(sdkBuild ? sdkRequiredArtifacts() : null),
    {
      gateId: 'source.changed-scope',
    },
  );
  if (!sdkBuild) cpVsDependencies();
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
  // Shifu strict cache execution supplies a disposable UV_PROJECT_ENVIRONMENT;
  // ordinary development continues to use the project-local .venv.
  // 不解 realpath：venv 的 python 是指向 base python 的 symlink，靠“在 .venv/bin 下”这一
  // 路径语义才会启用 venv site-packages（setuptools 的 _distutils shim）；解到真身就丢了。
  const environment =
    process.env.UV_PROJECT_ENVIRONMENT || path.join(__dirname, '..', '.venv');
  const venvPy = path.join(
    environment,
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
      .command('build-sdk', () => build('sdk'))
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
