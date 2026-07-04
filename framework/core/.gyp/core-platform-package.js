// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Pack `@kungfu-tech/core` as npm prebuilt platform packages.
 *
 * Ported from libnode `.gyp/node-platform-package.js`. Differences for core:
 *  - payload is the native addon build tree `dist/kungfu` (not `dist/node`);
 *  - each platform package runtime-depends on `@kungfu-tech/libnode` (decision
 *    (1)) and colocates its shared library next to the addon so the addon's
 *    `@loader_path` / `$ORIGIN` / same-dir-DLL runtime lookup resolves;
 *  - Release/Debug is carried in the package name (CI defaults to Release).
 */

const childProcess = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const sywac = require('sywac');
const {
  MODULE_NAME,
  BINDING_SUBDIR,
  platformPackages,
  currentPlatformPackage,
  packageNameForConfiguration,
} = require('../lib/platform-packages.js');

const rootDir = path.dirname(__dirname);
const bindingDir = path.join(rootDir, BINDING_SUBDIR);
const stageDir = path.resolve(
  rootDir,
  process.env.KF_PACKAGE_STAGE_DIR || path.join('build', 'stage', 'npm'),
);
const packageBuildDir = path.join(rootDir, 'build', 'npm');

/** Release by default; developers/CI select Debug via build_type. */
function configuration() {
  return process.env.npm_package_config_build_type === 'Debug'
    ? 'Debug'
    : 'Release';
}

function readJson(file) {
  return fs.readJsonSync(path.join(rootDir, file));
}

function writeJson(file, value) {
  fs.writeJsonSync(file, value, { spaces: 2 });
  fs.appendFileSync(file, '\n');
}

function rootPackageJson() {
  return readJson('package.json');
}

function libnodeVersion(sourcePackageJson) {
  const version =
    (sourcePackageJson.devDependencies || {})['@kungfu-tech/libnode'] ||
    (sourcePackageJson.dependencies || {})['@kungfu-tech/libnode'];
  if (!version) {
    throw new Error(
      'Cannot determine @kungfu-tech/libnode version from package.json',
    );
  }
  return version;
}

function packageDirName(packageName) {
  return packageName.replace(/^@/, '').replace('/', '-');
}

function requireBindingTree() {
  if (!fs.existsSync(bindingDir)) {
    throw new Error(
      `Missing ${path.relative(rootDir, bindingDir)}. Run the build lifecycle before packaging.`,
    );
  }
  const addon = path.join(bindingDir, `${MODULE_NAME}.node`);
  if (!fs.existsSync(addon)) {
    throw new Error(
      `Missing native addon: expected ${path.relative(rootDir, addon)}`,
    );
  }
}

function basePackageJson(sourcePackageJson, name, description) {
  return {
    name,
    version: sourcePackageJson.version,
    description,
    license: sourcePackageJson.license,
    author: sourcePackageJson.author,
    repository: sourcePackageJson.repository,
    publishConfig: sourcePackageJson.publishConfig,
  };
}

function optionalDependencyMap(sourcePackageJson, config) {
  return Object.fromEntries(
    platformPackages.map((item) => [
      packageNameForConfiguration(item.name, config),
      sourcePackageJson.version,
    ]),
  );
}

function writePackageReadme(packageRoot, packageName, description) {
  fs.writeFileSync(
    path.join(packageRoot, 'README.md'),
    `# ${packageName}\n\n${description}\n`,
  );
}

/**
 * Colocate the libnode shared library next to the core addon. Runs at platform
 * package postinstall AND lazily at runtime (index.js), so it is robust to npm
 * postinstall ordering: whichever fires after `@kungfu-tech/libnode` is present
 * wins, and it is idempotent. libnode remains the single source of the binary
 * (decision (1)); core never bundles a second copy.
 */
function writeColocateScript(packageRoot) {
  fs.writeFileSync(
    path.join(packageRoot, 'ensure-libnode-colocated.js'),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      '',
      "const bindingDir = path.join(__dirname, 'dist', 'kungfu');",
      '',
      'function libnodeLibpath() {',
      '  try {',
      "    return require('@kungfu-tech/libnode').libpath;",
      '  } catch (error) {',
      '    return null;', // libnode not resolvable yet; a later trigger will retry
      '  }',
      '}',
      '',
      'function ensureLibnodeColocated() {',
      '  const libpath = libnodeLibpath();',
      '  if (!libpath || !fs.existsSync(libpath)) return false;',
      '  let colocated = false;',
      '  for (const entry of fs.readdirSync(libpath)) {',
      '    if (!/^libnode[.]/.test(entry)) continue;',
      '    const src = path.join(libpath, entry);',
      '    if (!fs.statSync(src).isFile()) continue;',
      '    const dst = path.join(bindingDir, entry);',
      '    try {',
      '      if (fs.existsSync(dst)) continue;',
      "      try { fs.symlinkSync(src, dst, 'file'); }",
      '      catch (linkError) { fs.copyFileSync(src, dst); }',
      '      colocated = true;',
      '    } catch (error) {',
      "      if (error.code !== 'EEXIST') throw error;",
      '    }',
      '  }',
      '  return colocated;',
      '}',
      '',
      'module.exports = { ensureLibnodeColocated };',
      '',
      'if (require.main === module) ensureLibnodeColocated();',
      '',
    ].join('\n'),
  );
}

function writePlatformIndex(packageRoot) {
  fs.writeFileSync(
    path.join(packageRoot, 'index.js'),
    [
      "const path = require('path');",
      "const { ensureLibnodeColocated } = require('./ensure-libnode-colocated.js');",
      '',
      '// Lazy, idempotent colocation guarantees libnode sits next to the addon',
      '// before the core resolver loads it, regardless of postinstall ordering.',
      'ensureLibnodeColocated();',
      '',
      "exports.bindingDir = path.join(__dirname, 'dist', 'kungfu');",
      '',
    ].join('\n'),
  );
}

function prepareMainPackage() {
  const sourcePackageJson = rootPackageJson();
  const config = configuration();
  const packageRoot = path.join(packageBuildDir, 'core');
  fs.emptyDirSync(packageRoot);

  const packageJson = {
    ...basePackageJson(
      sourcePackageJson,
      sourcePackageJson.name,
      'Kungfu core entrypoint package with platform-specific optional dependencies',
    ),
    main: sourcePackageJson.main,
    bin: sourcePackageJson.bin,
    config: sourcePackageJson.config,
    scripts: { install: 'node .gyp/noop-install.js' },
    files: ['lib/', '.gyp/noop-install.js', 'LICENSE', 'README.md'],
    optionalDependencies: optionalDependencyMap(sourcePackageJson, config),
  };

  writeJson(path.join(packageRoot, 'package.json'), packageJson);
  fs.copySync(path.join(rootDir, 'lib'), path.join(packageRoot, 'lib'));
  fs.ensureDirSync(path.join(packageRoot, '.gyp'));
  fs.copySync(
    path.join(rootDir, '.gyp', 'noop-install.js'),
    path.join(packageRoot, '.gyp', 'noop-install.js'),
  );
  copyIfExists(
    path.join(rootDir, 'LICENSE'),
    path.join(packageRoot, 'LICENSE'),
  );
  writePackageReadme(
    packageRoot,
    sourcePackageJson.name,
    'This package resolves the matching Kungfu core platform package at runtime.',
  );

  return packageRoot;
}

function copyIfExists(source, target) {
  if (fs.existsSync(source))
    fs.copySync(source, target, { dereference: false });
}

function preparePlatformPackage(descriptor) {
  requireBindingTree();

  const sourcePackageJson = rootPackageJson();
  const config = configuration();
  const packageName = packageNameForConfiguration(descriptor.name, config);
  const packageRoot = path.join(packageBuildDir, packageDirName(packageName));
  fs.emptyDirSync(packageRoot);

  const packageJson = {
    ...basePackageJson(
      sourcePackageJson,
      packageName,
      `Kungfu core native addon for ${descriptor.key} (${config})`,
    ),
    main: 'index.js',
    files: [
      'index.js',
      'ensure-libnode-colocated.js',
      'dist/',
      'LICENSE',
      'README.md',
    ],
    os: descriptor.os,
    cpu: descriptor.cpu,
    optionalDependencies: {
      '@kungfu-tech/libnode': libnodeVersion(sourcePackageJson),
    },
    scripts: { postinstall: 'node ensure-libnode-colocated.js' },
  };

  writeJson(path.join(packageRoot, 'package.json'), packageJson);
  fs.copySync(bindingDir, path.join(packageRoot, 'dist', 'kungfu'), {
    dereference: false,
  });
  copyIfExists(
    path.join(rootDir, 'LICENSE'),
    path.join(packageRoot, 'LICENSE'),
  );
  writePackageReadme(
    packageRoot,
    packageName,
    `This package contains the Kungfu core native addon for ${descriptor.key} (${config}).`,
  );
  writeColocateScript(packageRoot);
  writePlatformIndex(packageRoot);
  console.log(
    `prepared ${packageName} from ${path.relative(rootDir, bindingDir)}`,
  );

  return packageRoot;
}

function npmPack(packageRoot) {
  fs.ensureDirSync(stageDir);
  const { command, args } = npmCommand('pack', '--pack-destination', stageDir);
  const result = childProcess.spawnSync(command, args, {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const error = result.error ? `: ${result.error.message}` : '';
    throw new Error(`npm pack failed for ${packageRoot}${error}`);
  }
}

function npmCommand(...args) {
  const nodeDir = path.dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [
          path.join(
            path.dirname(nodeDir),
            'lib',
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js',
          ),
        ];

  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (npmCli) {
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command: 'npm', args };
}

function shouldPackMain() {
  if (process.env.KF_PACK_MAIN_PACKAGE === 'true') return true;
  if (process.env.KF_PACK_MAIN_PACKAGE === 'false') return false;
  return process.platform === 'linux' && process.arch === 'x64';
}

function currentDescriptor() {
  const descriptor = currentPlatformPackage();
  if (!descriptor) {
    throw new Error(
      `Unsupported core platform package target: ${process.platform}-${process.arch}`,
    );
  }
  return descriptor;
}

async function packMain() {
  npmPack(prepareMainPackage());
}

async function packPlatform() {
  npmPack(preparePlatformPackage(currentDescriptor()));
}

async function pack() {
  await packPlatform();
  if (shouldPackMain()) await packMain();
}

async function verifySource() {
  const sourcePackageJson = rootPackageJson();
  const scripts = sourcePackageJson.scripts || {};

  if (scripts.install !== 'node .gyp/noop-install.js') {
    throw new Error(
      'package.json install script must be the core no-op install guard',
    );
  }
  for (const scriptName of ['preinstall', 'prebuild']) {
    if (scripts[scriptName]) {
      throw new Error(`package.json must not define ${scriptName}`);
    }
  }
  // core keeps a build-only node-pre-gyp descriptor (build driver), but the
  // retired self-hosted download must not come back.
  if (sourcePackageJson.binary?.host || sourcePackageJson.binary?.remote_path) {
    throw new Error(
      'package.json binary block must not define a download host/remote_path',
    );
  }
  if (sourcePackageJson.dependencies?.['@mapbox/node-pre-gyp']) {
    throw new Error(
      '@mapbox/node-pre-gyp must be a devDependency (build-only), not a runtime dependency',
    );
  }
  for (const descriptor of platformPackages) {
    if (!descriptor.name.startsWith(`${sourcePackageJson.name}-`)) {
      throw new Error(`Unexpected platform package name: ${descriptor.name}`);
    }
  }
}

async function main() {
  await sywac
    .command('pack', {
      desc: 'Pack the current platform package and, on linux-x64, the main package',
      run: pack,
    })
    .command('pack-main', {
      desc: 'Pack the main entrypoint package',
      run: packMain,
    })
    .command('pack-platform', {
      desc: 'Pack the current platform package',
      run: packPlatform,
    })
    .command('verify-source', {
      desc: 'Verify source package metadata for prebuilt platform-package distribution',
      run: verifySource,
    })
    .help('-h, --help')
    .version('-v, --version')
    .parseAndExit();
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
