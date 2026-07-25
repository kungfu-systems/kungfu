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

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const path = require('node:path');
const sywac = require('sywac');
const {
  MODULE_NAME,
  BINDING_SUBDIR,
  platformPackages,
  currentPlatformPackage,
  packageNameForConfiguration,
} = require('../lib/platform-packages.js');

const rootDir = path.dirname(__dirname);
const repositoryRoot = path.resolve(rootDir, '..', '..');
const bindingDir = path.join(rootDir, BINDING_SUBDIR);
const stageDir = path.resolve(
  rootDir,
  process.env.KF_PACKAGE_STAGE_DIR || path.join('build', 'stage', 'npm'),
);
const packageBuildDir = path.join(rootDir, 'build', 'npm');
const packageContract = fs.readJsonSync(
  path.join(rootDir, 'core-platform-package.contract.json'),
);

/**
 * @typedef {{
 *   name: string,
 *   version: string,
 *   description?: string,
 *   license?: string,
 *   author?: unknown,
 *   repository?: unknown,
 *   publishConfig?: unknown,
 *   main?: string,
 *   types?: string,
 *   bin?: unknown,
 *   files?: string[],
 *   config?: unknown,
 *   dependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   scripts?: Record<string, string>
 * }} CorePackageJson
 *
 * @typedef {{
 *   name: string,
 *   key: string,
 *   os?: string[],
 *   cpu?: string[]
 * }} PlatformDescriptor
 *
 * @typedef {{ command: string, args: string[] }} NpmCommand
 * @typedef {{
 *   name: string,
 *   version: string,
 *   filename: string,
 *   size: number,
 *   unpackedSize: number,
 *   entryCount: number,
 *   files: Array<{path: string}>
 * }} NpmPackEntry
 */

/** Release by default; developers/CI select Debug via build_type. */
function configuration() {
  return process.env.npm_package_config_build_type === 'Debug'
    ? 'Debug'
    : 'Release';
}

/**
 * @param {string} file
 * @returns {CorePackageJson}
 */
function readJson(file) {
  return fs.readJsonSync(path.join(rootDir, file));
}

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(file, value) {
  fs.writeJsonSync(file, value, { spaces: 2 });
  fs.appendFileSync(file, '\n');
}

/** @returns {CorePackageJson} */
function rootPackageJson() {
  return readJson('package.json');
}

/**
 * @param {string} packageName
 * @returns {string}
 */
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

/**
 * @param {CorePackageJson} sourcePackageJson
 * @param {string} name
 * @param {string} description
 * @returns {Record<string, unknown>}
 */
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

/**
 * @param {CorePackageJson} sourcePackageJson
 * @param {string} config
 * @returns {Record<string, string>}
 */
function optionalDependencyMap(sourcePackageJson, config) {
  return Object.fromEntries(
    platformPackages.map((item) => [
      packageNameForConfiguration(item.name, config),
      sourcePackageJson.version,
    ]),
  );
}

/**
 * @param {string} packageRoot
 * @param {string} packageName
 * @param {string} description
 * @returns {void}
 */
function writePackageReadme(packageRoot, packageName, description) {
  fs.writeFileSync(
    path.join(packageRoot, 'README.md'),
    `# ${packageName}\n\n${description}\n`,
  );
}

/**
 * @param {string} packageRoot
 * @returns {void}
 */
function writePlatformIndex(packageRoot) {
  fs.writeFileSync(
    path.join(packageRoot, 'index.js'),
    [
      "const path = require('path');",
      '',
      '// The addon and its full runtime (libkungfu, libnode) are bundled in',
      '// dist/kungfu by the build (link-node + stage); this package is',
      '// self-contained and needs no install-time colocation.',
      "exports.runtimeDir = path.join(__dirname, 'dist', 'kungfu');",
      'exports.bindingDir = exports.runtimeDir;',
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
    types: sourcePackageJson.types,
    bin: sourcePackageJson.bin,
    config: sourcePackageJson.config,
    dependencies: sourcePackageJson.dependencies,
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
    path.join(repositoryRoot, 'LICENSE'),
    path.join(packageRoot, 'LICENSE'),
  );
  writePackageReadme(
    packageRoot,
    sourcePackageJson.name,
    'This package resolves the matching Kungfu core platform package at runtime.',
  );

  return packageRoot;
}

/**
 * @param {string} source
 * @param {string} target
 * @returns {void}
 */
function copyIfExists(source, target) {
  if (fs.existsSync(source))
    fs.copySync(source, target, { dereference: false });
}

/** @param {string} value @returns {string} */
function portablePath(value) {
  return value.split(path.sep).join('/');
}

/** @param {string} relative @returns {boolean} */
function isExcludedPayloadPath(relative) {
  const portable = `dist/kungfu/${portablePath(relative)}`;
  const segments = portable.split('/');
  /** @type {string[]} */
  const excludedPathPrefixes =
    packageContract.platformPayload.excludedPathPrefixes;
  if (excludedPathPrefixes.some((prefix) => portable.startsWith(prefix)))
    return true;
  /** @type {string[]} */
  const excludedPathSegments =
    packageContract.platformPayload.excludedPathSegments;
  if (excludedPathSegments.some((segment) => segments.includes(segment)))
    return true;
  const basename = path.posix.basename(portable);
  /** @type {string[]} */
  const excludedBasenamePatterns =
    packageContract.platformPayload.excludedBasenamePatterns;
  return excludedBasenamePatterns.some((pattern) =>
    new RegExp(pattern, 'u').test(basename),
  );
}

/** @param {string} packageRoot @returns {string[]} */
function listPackageFiles(packageRoot) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() || entry.isSymbolicLink())
        files.push(portablePath(path.relative(packageRoot, target)));
    }
  };
  visit(packageRoot);
  return files;
}

/** @param {string} packageRoot @returns {void} */
function copyPlatformPayload(packageRoot) {
  fs.copySync(bindingDir, path.join(packageRoot, 'dist', 'kungfu'), {
    dereference: false,
    filter(source) {
      const relative = path.relative(bindingDir, source);
      return relative === '' || !isExcludedPayloadPath(relative);
    },
  });
}

/**
 * npm excludes symbolic links from package archives. Materialize only the
 * platform interpreter entrypoint that consumers execute directly; preserve
 * the rest of the frozen runtime tree as assembled.
 * @param {string} packageRoot
 * @returns {void}
 */
function materializePythonEntrypoint(packageRoot) {
  const relative =
    process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
  const source = path.join(bindingDir, relative);
  const target = path.join(packageRoot, 'dist', 'kungfu', relative);
  if (!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink()) return;
  const realSource = fs.realpathSync(source);
  const mode = fs.statSync(realSource).mode;
  fs.removeSync(target);
  fs.copyFileSync(realSource, target);
  fs.chmodSync(target, mode);
  const realRelative = path.relative(bindingDir, realSource);
  if (
    realRelative.startsWith('..') ||
    path.isAbsolute(realRelative) ||
    path.dirname(realRelative) !== path.dirname(relative)
  ) {
    throw new Error(
      `Python entrypoint resolves outside its declared bin directory: ${realRelative}`,
    );
  }
  const redundantTarget = path.join(
    packageRoot,
    'dist',
    'kungfu',
    realRelative,
  );
  if (redundantTarget !== target) fs.removeSync(redundantTarget);
}

/**
 * Release platform packages do not publish link/debug tables. Keep the
 * selection explicit so the embedded Python runtime and pinned libnode input
 * are never rewritten by this package projection.
 * @param {string[]} files
 * @returns {string[]}
 */
function linuxReleaseStripCandidates(files) {
  return files.filter((file) =>
    /^dist\/kungfu\/(?:[^/]+\.(?:node|so)|libwasm\/[^/]+\.so|kungfu-(?:kfd-agent-runtime|wasm-host))$/u.test(
      file,
    ),
  );
}

/**
 * @param {string} packageRoot
 * @returns {void}
 */
function stripLinuxReleasePayload(packageRoot) {
  if (process.platform !== 'linux' || configuration() !== 'Release') return;
  for (const relative of linuxReleaseStripCandidates(
    listPackageFiles(packageRoot),
  )) {
    const target = path.join(packageRoot, relative);
    const result = childProcess.spawnSync(
      'strip',
      ['--strip-unneeded', target],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      const diagnostic = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `strip failed for ${relative}${diagnostic ? `: ${diagnostic}` : ''}`,
      );
    }
  }
}

/**
 * @param {string} packageRoot
 * @param {string} packageName
 * @returns {{files: string[], prohibited: string[]}}
 */
function validatePlatformPayload(packageRoot, packageName) {
  const files = listPackageFiles(packageRoot);
  const prohibited = files.filter((file) =>
    isExcludedPayloadPath(file.replace(/^dist\/kungfu\//u, '')),
  );
  if (prohibited.length > 0) {
    throw new Error(
      `${packageName} contains prohibited payloads: ${prohibited.join(', ')}`,
    );
  }
  for (const pattern of packageContract.platformPayload.requiredPathPatterns) {
    if (!files.some((file) => new RegExp(pattern, 'u').test(file))) {
      throw new Error(
        `${packageName} lacks required payload pattern ${pattern}`,
      );
    }
  }
  return { files, prohibited };
}

/**
 * @param {PlatformDescriptor} descriptor
 * @returns {string}
 */
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
    files: ['index.js', 'dist/', 'LICENSE', 'README.md'],
    os: descriptor.os,
    cpu: descriptor.cpu,
  };

  writeJson(path.join(packageRoot, 'package.json'), packageJson);
  copyPlatformPayload(packageRoot);
  materializePythonEntrypoint(packageRoot);
  stripLinuxReleasePayload(packageRoot);
  copyIfExists(
    path.join(repositoryRoot, 'LICENSE'),
    path.join(packageRoot, 'LICENSE'),
  );
  writePackageReadme(
    packageRoot,
    packageName,
    `This package contains the Kungfu core native addon for ${descriptor.key} (${config}).`,
  );
  writePlatformIndex(packageRoot);
  validatePlatformPayload(packageRoot, packageName);
  console.log(
    `prepared ${packageName} from ${path.relative(rootDir, bindingDir)}`,
  );

  return packageRoot;
}

/**
 * @param {string} packageRoot
 * @returns {unknown}
 */
function npmPack(packageRoot) {
  fs.ensureDirSync(stageDir);
  const { command, args } = npmCommand(
    'pack',
    '--json',
    '--pack-destination',
    stageDir,
  );
  const result = childProcess.spawnSync(command, args, {
    cwd: packageRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    const error = result.error ? `: ${result.error.message}` : '';
    throw new Error(`npm pack failed for ${packageRoot}${error}`);
  }
  /** @type {NpmPackEntry[]} */
  let entries;
  try {
    entries = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${packageRoot}`);
  }
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error(
      `npm pack returned ${entries?.length || 0} entries for ${packageRoot}`,
    );
  }
  const packed = entries[0];
  const archive = path.join(stageDir, packed.filename);
  if (!fs.existsSync(archive)) {
    throw new Error(`npm pack did not produce ${archive}`);
  }
  const isMain = packed.name === rootPackageJson().name;
  const hardCeiling = isMain
    ? packageContract.mainPackage.compressedHardCeilingBytes
    : packageContract.sizePolicy.compressedHardCeilingBytes;
  if (packed.size > hardCeiling) {
    throw new Error(
      `${packed.name} compressed size ${packed.size} exceeds hard ceiling ${hardCeiling}`,
    );
  }
  const files = (packed.files || []).map((entry) => entry.path).sort();
  const prohibited = isMain
    ? files.filter((file) =>
        /(^|\/)(?:dist|wheels)(\/|$)|\.(?:node|dylib|so|dll|exe|whl)$/iu.test(
          file,
        ),
      )
    : files.filter((file) =>
        isExcludedPayloadPath(file.replace(/^dist\/kungfu\//u, '')),
      );
  if (prohibited.length > 0) {
    throw new Error(
      `${packed.name} archive contains prohibited paths: ${prohibited.join(', ')}`,
    );
  }
  if (isMain) {
    for (const requiredPath of packageContract.mainPackage.requiredPaths) {
      if (!files.includes(requiredPath)) {
        throw new Error(
          `${packed.name} archive lacks required path ${requiredPath}`,
        );
      }
    }
  } else {
    for (const pattern of packageContract.platformPayload
      .requiredPathPatterns) {
      if (!files.some((file) => new RegExp(pattern, 'u').test(file))) {
        throw new Error(
          `${packed.name} archive lacks required payload pattern ${pattern}`,
        );
      }
    }
  }
  const receipt = {
    schema: 'kungfu.core-platform-package.receipt/v1',
    package: packed.name,
    version: packed.version,
    platform: isMain ? 'portable' : currentDescriptor().key,
    archive: packed.filename,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(archive))
      .digest('hex'),
    compressedBytes: packed.size,
    unpackedBytes: packed.unpackedSize,
    fileCount: packed.entryCount,
    files,
    executables: files.filter((file) =>
      /(^|\/)kungfu(?:-trunk|-kfd-agent-runtime|-wasm-host)?(?:\.exe)?$/u.test(
        file,
      ),
    ),
    nativeLibraries: files.filter((file) =>
      /\.(?:node|dylib|so|dll)$/u.test(file),
    ),
    prohibitedContent: {
      status: 'passing',
      paths: prohibited,
    },
    sizePolicy: isMain
      ? {
          hardCeilingBytes: hardCeiling,
          status: 'passing',
        }
      : {
          hardCeilingBytes:
            packageContract.sizePolicy.compressedHardCeilingBytes,
          normalCeilingBytes:
            packageContract.sizePolicy.compressedNormalCeilingBytes,
          optimizationTargetBytes:
            packageContract.sizePolicy.compressedOptimizationTargetBytes,
          status:
            packed.size <=
            packageContract.sizePolicy.compressedOptimizationTargetBytes
              ? 'optimization-target'
              : packed.size <=
                  packageContract.sizePolicy.compressedNormalCeilingBytes
                ? 'normal'
                : 'review-required',
        },
  };
  const receiptPath = path.join(stageDir, `${packed.filename}.receipt.json`);
  writeJson(receiptPath, receipt);
  console.log(
    `packed ${packed.name}: ${packed.size} compressed bytes, ${packed.entryCount} files; receipt=${path.basename(receiptPath)}`,
  );
  return receipt;
}

/**
 * @param {...string} args
 * @returns {NpmCommand}
 */
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
  if (scripts.prepack !== 'node .gyp/refuse-source-pack.js') {
    throw new Error(
      'package.json prepack must refuse source-directory packing',
    );
  }
  if ((sourcePackageJson.files || []).includes('dist/kungfu')) {
    throw new Error('source package files must not include dist/kungfu');
  }
  for (const scriptName of ['preinstall', 'prebuild']) {
    if (scripts[scriptName]) {
      throw new Error(`package.json must not define ${scriptName}`);
    }
  }
  // core still keeps node-pre-gyp as the build-only driver for the legacy
  // `package` tarball (binary.host is retained only for node-pre-gyp's config
  // validation; install/build never download from it). The invariant that
  // matters for prebuilt distribution is that node-pre-gyp is not a runtime
  // dependency and install stays a no-op.
  if (sourcePackageJson.dependencies?.['@mapbox/node-pre-gyp']) {
    throw new Error(
      '@mapbox/node-pre-gyp must be a devDependency (build-only), not a runtime dependency',
    );
  }
  const sourceOptionalDeps = sourcePackageJson.optionalDependencies || {};
  for (const descriptor of platformPackages) {
    const releaseName = descriptor.name;
    const debugName = packageNameForConfiguration(descriptor.name, 'Debug');
    if (sourceOptionalDeps[releaseName] || sourceOptionalDeps[debugName]) {
      throw new Error(
        [
          'source package.json must not declare core platform optionalDependencies',
          `unexpected: ${sourceOptionalDeps[releaseName] ? releaseName : debugName}`,
          'platform optionalDependencies are generated only in the packed main package',
        ].join('\n'),
      );
    }
  }
  for (const descriptor of platformPackages) {
    if (!descriptor.name.startsWith(`${sourcePackageJson.name}-`)) {
      throw new Error(`Unexpected platform package name: ${descriptor.name}`);
    }
  }
  if (
    JSON.stringify(platformPackages) !==
    JSON.stringify(packageContract.platformPackages)
  ) {
    throw new Error(
      'platform package authority differs from core-platform-package.contract.json',
    );
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

module.exports = {
  linuxReleaseStripCandidates,
};
