// SPDX-License-Identifier: Apache-2.0
//
// Stage C kfc freeze 独立入口（脱 conan2；对应迁移文档 D6 + Stage C wiring）。
//
// 背景：conan2 移除了独立 `conan package` 本地命令，原 `freeze`→run-conan.js package
// 只触发 `conan build`（占位，不跑 freezer）。本脚本把 freeze 做成 `./shifu freeze`
// 一步可复现；产物腿现只剩 assemble。
//
// 旧产品打包腿已于 2026-07-11 退役（KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2 收口：
// macOS→Linux→Windows 全部组装完整 CPython 树，Windows 为最后一块平台）；去留记账
// 见 docs/development/buildchain.md「Freeze retirement ledger」。
//
// - assemble（唯一产物腿，见 KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 与本文件 assemble 段注释）：宿主运行一棵完整精确的
//   CPython 树。dist/kungfu 保持扁平根（natives/contract/wheels），并在 dist/kungfu/python
//   下加解释器树；kungfu 包以源码随树发布，经 site-packages 的 .pth 接回扁平根。
// @ts-check

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { shell } = require('../lib');

const CORE = path.resolve(__dirname, '..'); // framework/core
const isWin = process.platform === 'win32';
// Product builds (dist.mjs) set this so a missing native host is a hard error,
// not a warning: the core is always built for the node runtime, so the host
// (libkungfu_node_host.* / kungfu_node_host.dll, and kungfu.dll on
// Windows) must ship, or the product silently falls back to the slow Python node
// path / the doctor stub (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 S3 productization gap). A bare `pnpm run
// freeze` (dev) leaves it unset and keeps the warn-only behavior — a dev assemble
// without a built host is legitimate.
const requireNativeHost = process.env.KF_REQUIRE_NATIVE_HOST === '1';
const { copyContractArtifacts } = require(
  path.join(CORE, '..', '..', 'scripts', 'contract-registry.cjs'),
);

function copyConfigContract() {
  copyContractArtifacts(path.join(CORE, 'dist', 'kungfu'));
}

function buildType() {
  return shell.getConfigValue('build_type') || 'Release';
}

function assemblySelector(explicit = shell.getConfigValue('freezer')) {
  // The legacy config key remains only as a fail-closed compatibility input.
  // Every supported platform ships the assembled runtime.
  if (explicit) return explicit;
  return 'assemble';
}

/** @param {string} selector */
function requireAssemblySelector(selector) {
  if (selector !== 'assemble') {
    throw new Error(
      `[assembly] retired product packager selector rejected; expected assemble, received ${selector}`,
    );
  }
  return selector;
}

// kungfu/__init__ 读 pykungfu 同目录的 kungfubuildinfo.json 取 version；缺则生成。
/**
 * @param {string} bt
 * @returns {string}
 */
function ensureBuildInfo(bt) {
  const dir = path.join(CORE, 'build', bt);
  const info = path.join(dir, 'kungfubuildinfo.json');
  if (fs.existsSync(info)) return info;
  console.log(`[freeze] buildinfo 缺失，生成 → ${info}`);
  fs.mkdirSync(dir, { recursive: true });
  shell.run(
    'uv',
    [
      'run',
      '--frozen',
      'python3',
      path.join(CORE, '.gyp', 'gen_kungfubuildinfo.py'),
      info,
    ],
    true,
    { cwd: CORE },
  );
  return info;
}

// app/electron 侧 node native：Python 进程不 import，组装树需从 build/<type> 补拷。
// app 栈通过 @kungfu-tech/core/dist/kungfu/<x> 解析它们（getKfcDir / webpack require.resolve）。
const APP_NATIVE = [
  'drone.node',
  'kungfu_node.node',
  'kungfu_electron.node',
  'link_node.node',
];

function agentPackDataArgs() {
  const root = path.join(CORE, 'src', 'python', 'kungfu', 'agent');
  /** @type {string[]} */
  const args = [];
  /** @param {string} dir */
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__') walk(full);
      } else if (!entry.name.endsWith('.py')) {
        const rel = path.relative(root, full);
        args.push(`--include-data-files=${full}=${path.join('agent', rel)}`);
      }
    }
  }
  walk(root);
  return args;
}

function documentationAtlasSource(repository = path.resolve(CORE, '..', '..')) {
  const selector = path.join(
    repository,
    '.xinfa',
    'product-documentation-pack.json',
  );
  if (!fs.existsSync(selector)) {
    throw new Error('[freeze] missing .xinfa/product-documentation-pack.json');
  }
  const contract = JSON.parse(fs.readFileSync(selector, 'utf8'));
  const atlasDigest = String(contract.atlasRoot || '').slice('sha256:'.length);
  const expectedBundleRoot = `.xinfa/material-bundles/sha256/${atlasDigest}`;
  if (
    contract.schema !== 'kungfu.product-documentation-pack/v1' ||
    !/^sha256:[0-9a-f]{64}$/.test(contract.atlasRoot || '') ||
    contract.materialSource?.kind !== 'tracked-gzip' ||
    !/^[0-9a-f]{40}$/.test(contract.materialSource?.originCommit || '') ||
    contract.materialSource?.bundleRoot !== expectedBundleRoot
  ) {
    throw new Error('[freeze] invalid product Documentation Atlas selector');
  }
  const root = path.join(
    repository,
    '.xinfa',
    'baselines',
    'sha256',
    atlasDigest,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
  );
  const bundleRoot = path.join(
    repository,
    ...contract.materialSource.bundleRoot.split('/'),
  );
  for (const artifact of manifest.artifacts || []) {
    const relative = String(artifact.path || '');
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes('\\') ||
      relative.split('/').includes('..')
    ) {
      throw new Error(
        `[freeze] invalid Documentation Atlas artifact path: ${relative}`,
      );
    }
    const target = path.join(root, ...relative.split('/'));
    let bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const expected = String(artifact.content_root || '');
    /** @param {Buffer} value */
    const valid = (value) =>
      value.length === artifact.size &&
      `sha256:${crypto.createHash('sha256').update(value).digest('hex')}` ===
        expected;
    if (bytes !== null && !valid(bytes)) {
      throw new Error(
        `[freeze] Documentation Atlas material differs from its tracked witness: ${relative}`,
      );
    }
    if (bytes === null) {
      try {
        const candidate = zlib.gunzipSync(
          fs.readFileSync(
            `${path.join(bundleRoot, ...relative.split('/'))}.gz`,
          ),
        );
        if (valid(candidate)) bytes = candidate;
      } catch {
        // The exact content-root check below owns the final failure.
      }
      if (bytes === null) {
        throw new Error(
          `[freeze] Documentation Atlas material source differs from its tracked witness: ${relative}`,
        );
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      console.log(
        `[freeze] restored witnessed Documentation Atlas material from tracked gzip: ${relative}`,
      );
    }
  }
  const atlas = JSON.parse(
    fs.readFileSync(path.join(root, 'atlas.json'), 'utf8'),
  );
  if (
    atlas.atlas_root !== contract.atlasRoot ||
    atlas.roots?.context_pack !== contract.contextPackRoot ||
    atlas.visibility !== 'public'
  ) {
    throw new Error('[freeze] product Documentation Atlas selector drifted');
  }
  return root;
}

/** @param {unknown} value @returns {unknown} */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

/** @param {Buffer|string} value */
function sha256Root(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function portableAtlasBundleSource(
  repository = path.resolve(CORE, '..', '..'),
) {
  const manifestPath = path.join(
    repository,
    '.xinfa',
    'product-atlas-bundle.json',
  );
  const classificationPath = path.join(
    repository,
    '.xinfa',
    'portable-atlas-classification.json.gz',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { bundleRoot: declaredRoot, ...core } = manifest;
  const computedRoot = sha256Root(`${JSON.stringify(canonicalJson(core))}\n`);
  const classificationCompressed = fs.readFileSync(classificationPath);
  const classificationBytes = zlib.gunzipSync(classificationCompressed);
  const classification = JSON.parse(classificationBytes.toString('utf8'));
  if (
    manifest.schema !== 'kungfu.portable-atlas-bundle/v1' ||
    declaredRoot !== computedRoot ||
    manifest.classification?.classificationRoot !==
      sha256Root(classificationBytes) ||
    manifest.classification?.material?.compressedBytes !==
      classificationCompressed.length ||
    manifest.classification?.material?.uncompressedBytes !==
      classificationBytes.length ||
    classification.unknown !== 0 ||
    classification.silentOmissions !== 0 ||
    manifest.routes?.incompleteRoutes !== 0 ||
    manifest.budgets?.passed !== true
  ) {
    throw new Error(
      '[freeze] Portable Kungfu Atlas Bundle verification failed',
    );
  }
  return { manifestPath, classificationPath, manifest };
}

/**
 * Keep generated interpreter caches out of installed first-party Profiles.
 * Workspace node_modules are transient build-tree state. Declared Suite
 * members are materialized separately into a stable package closure.
 *
 * @param {string} src
 * @returns {boolean}
 */
function firstPartyProfileFilter(src) {
  const segments = path.resolve(src).split(path.sep);
  return (
    !segments.includes('__pycache__') && !segments.includes('node_modules')
  );
}

/**
 * Copy the authored Suite, then close every declared member independently of
 * pnpm's build-worktree layout.
 *
 * @param {string} source
 * @param {string} destination
 */
function copyFirstPartyProfile(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: firstPartyProfileFilter,
  });
  materializeFirstPartyProfileMembers(source, destination);
}

/**
 * Stage the same Work Profile conformance closure as the wheel build.  The
 * assembled product copies Python sources directly, so wheel build_py hooks do
 * not run for this tree.
 *
 * @param {string} destination
 * @param {string} repositoryRoot
 */
function copyWorkProfileConformance(
  destination,
  repositoryRoot = path.resolve(CORE, '..', '..'),
) {
  const source = path.join(
    repositoryRoot,
    'framework',
    'work-profile-conformance',
  );
  fs.cpSync(source, destination, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(source, 'authority-manifest.json'), 'utf8'),
  );
  const authorityRoot = path.join(destination, 'authority');
  const repositoryBoundary = path.resolve(repositoryRoot) + path.sep;
  for (const coordinate of manifest.files) {
    const sourceFile = path.resolve(repositoryRoot, coordinate.path);
    if (!sourceFile.startsWith(repositoryBoundary)) {
      throw new Error(
        `[freeze] invalid Work conformance authority path: ${coordinate.path}`,
      );
    }
    const destinationFile = path.join(authorityRoot, coordinate.path);
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fs.copyFileSync(sourceFile, destinationFile);
  }
}

/**
 * Stage the product-owned Work Design runtime used by the installed CLI.
 * Keep the authored module layout so its relative ESM imports remain exact.
 *
 * @param {string} destination
 * @param {string} repositoryRoot
 */
function copyWorkDesignRuntime(
  destination,
  repositoryRoot = path.resolve(CORE, '..', '..'),
) {
  const files = [
    'project-cut/src/project-cut.mjs',
    'work-history-selector/src/work-history-selector.mjs',
    'work-design-advisor/src/work-design-advisor.mjs',
    'work-design-preflight/src/work-design-preflight.mjs',
    'work-design-preflight/tooling/work-design-preflight.mjs',
  ];
  for (const relative of files) {
    const source = path.join(repositoryRoot, 'framework', relative);
    const target = path.join(destination, 'framework', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

/**
 * A hoisted pnpm install can satisfy a Suite dependency only from the
 * repository root, leaving the Suite's own node_modules absent.  Installed
 * Profiles cannot depend on that build-worktree layout, so copy every declared
 * member that is not already inside the Suite from the sibling first-party
 * extension set and verify the resulting closure.
 *
 * @param {string} source
 * @param {string} destination
 */
function materializeFirstPartyProfileMembers(source, destination) {
  const manifestPath = path.join(source, 'kungfu.kfx.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const members = manifest.kungfuConfig?.suite?.members;
  if (!Array.isArray(members)) return;
  const memberDestination = path.join(destination, 'members');
  fs.mkdirSync(memberDestination, { recursive: true });

  /** @param {string} directory */
  const packageKey = (directory) => {
    const candidate = path.join(directory, 'kungfu.kfx.json');
    if (!fs.existsSync(candidate)) return '';
    const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    return value.kungfuConfig?.key || '';
  };
  /** @param {string} member */
  const installedCandidates = (member) => {
    const roots = [destination, path.join(destination, 'members')];
    const dependencies = path.join(destination, 'node_modules');
    if (fs.existsSync(dependencies)) {
      roots.push(dependencies);
      for (const entry of fs.readdirSync(dependencies, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() && entry.name.startsWith('@')) {
          roots.push(path.join(dependencies, entry.name));
        }
      }
    }
    return roots.flatMap((root) => {
      if (!fs.existsSync(root)) return [];
      return [
        root,
        ...fs
          .readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name)),
      ].filter((directory) => packageKey(directory) === member);
    });
  };

  for (const member of members) {
    if (installedCandidates(member).length) continue;
    const candidates = fs
      .readdirSync(path.dirname(source), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(path.dirname(source), entry.name))
      .filter((directory) => packageKey(directory) === member);
    if (candidates.length !== 1) {
      throw new Error(
        `[freeze] first-party Profile member ${member} resolved ${candidates.length} times`,
      );
    }
    fs.cpSync(candidates[0], path.join(memberDestination, member), {
      recursive: true,
      dereference: true,
      filter: firstPartyProfileFilter,
    });
  }

  for (const member of members) {
    const candidates = installedCandidates(member);
    if (candidates.length !== 1) {
      throw new Error(
        `[freeze] installed first-party Profile member ${member} resolved ${candidates.length} times`,
      );
    }
  }
}

// Ship <binary>.pdb next to a native so Windows field crash reports can resolve
// kungfu frames to symbols; without it the stackwalker only prints module+offset
// (see docs/windows-crash-symbols.md). No-op off Windows or when no PDB exists
// (e.g. third-party natives, or a build without /Z7 + /DEBUG).
/**
 * @param {string} binPath
 * @param {string} destDir
 */
function copyPdbSibling(binPath, destDir) {
  const dir = path.dirname(binPath);
  const stem = path
    .basename(binPath)
    .replace(/\.(node|pyd|dll|exe)$/i, '')
    .split('.')[0];
  /** @type {string | null} */
  let pdb = binPath.replace(/\.(node|pyd|dll|exe)$/i, '.pdb');
  if (pdb === binPath || !fs.existsSync(pdb)) {
    // Fall back to any <stem>*.pdb the linker emitted next to the binary; the
    // PDB name follows the target output base, which for pykungfu carries an ABI
    // suffix. Matches the stem check in verify-windows-symbols.js.
    const cand = fs
      .readdirSync(dir)
      .find(
        (f) =>
          /\.pdb$/i.test(f) && f.toLowerCase().startsWith(stem.toLowerCase()),
      );
    pdb = cand ? path.join(dir, cand) : null;
  }
  if (!pdb || !fs.existsSync(pdb)) return;
  fs.copyFileSync(pdb, path.join(destDir, path.basename(pdb)));
}

/** @param {string} bt */
function copyAppNative(bt) {
  const buildDirs = [path.join(CORE, 'build', bt)];
  // CMake's Ninja layout places Windows addons directly under build/, while
  // POSIX layouts place them under build/<type>. Keep freeze aligned with the
  // staging search contract in run-build.js.
  if (isWin) buildDirs.push(path.join(CORE, 'build'));
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  let n = 0;
  for (const f of APP_NATIVE) {
    const from = buildDirs
      .map((dir) => path.join(dir, f))
      .find((candidate) => fs.existsSync(candidate));
    if (!from) continue;
    fs.copyFileSync(from, path.join(distKfc, f));
    copyPdbSibling(from, distKfc);
    n++;
  }
  console.log(`[freeze] 补拷 app native：${n}/${APP_NATIVE.length} 项`);
}

function copyLibwasmRuntime() {
  const buildDir = path.join(CORE, 'build');
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const hostName = isWin ? 'kungfu-wasm-host.exe' : 'kungfu-wasm-host';
  const host = findFileShallow(
    buildDir,
    isWin ? /^kungfu-wasm-host\.exe$/i : /^kungfu-wasm-host$/,
  );
  const adapterPatterns = isWin
    ? [/^kungfu_libwasm_wasmtime\.dll$/i, /^kungfu_libwasm_wasmer\.dll$/i]
    : process.platform === 'darwin'
      ? [
          /^libkungfu_libwasm_wasmtime\.dylib$/,
          /^libkungfu_libwasm_wasmer\.dylib$/,
        ]
      : [/^libkungfu_libwasm_wasmtime\.so$/, /^libkungfu_libwasm_wasmer\.so$/];
  const adapters = adapterPatterns.map((pattern) =>
    findFileShallow(buildDir, pattern),
  );
  if (!host || adapters.some((value) => !value)) {
    throw new Error(
      'production libwasm runtime is incomplete; rebuild core before freeze',
    );
  }
  const runtimeDir = path.join(distKfc, 'libwasm');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(host, path.join(distKfc, hostName));
  for (const adapter of adapters) {
    if (!adapter) {
      throw new Error('production libwasm adapter disappeared during staging');
    }
    fs.copyFileSync(adapter, path.join(runtimeDir, path.basename(adapter)));
    copyPdbSibling(adapter, runtimeDir);
  }
  const libwasmRoot = path.join(CORE, '..', '..', 'crates', 'libwasm');
  fs.copyFileSync(
    path.join(libwasmRoot, 'contract.json'),
    path.join(runtimeDir, 'contract.json'),
  );
  fs.cpSync(path.join(libwasmRoot, 'wit'), path.join(runtimeDir, 'wit'), {
    recursive: true,
  });
  const includeDir = path.join(runtimeDir, 'include', 'kungfu');
  fs.mkdirSync(includeDir, { recursive: true });
  fs.copyFileSync(
    path.join(CORE, 'src', 'libwasm', 'include', 'kungfu', 'libwasm.h'),
    path.join(includeDir, 'libwasm.h'),
  );
  console.log('[freeze] production libwasm host + dual-engine adapters staged');
}

/** @param {string} bt */
function copyKfdAgentRuntime(bt) {
  const buildDir = path.join(CORE, 'build');
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const binaryName = isWin
    ? 'kungfu-kfd-agent-runtime.exe'
    : 'kungfu-kfd-agent-runtime';
  const configured = path.join(buildDir, bt, binaryName);
  const source = fs.existsSync(configured)
    ? configured
    : findFileShallow(
        buildDir,
        isWin
          ? /^kungfu-kfd-agent-runtime\.exe$/i
          : /^kungfu-kfd-agent-runtime$/,
      );
  if (!source) {
    throw new Error(
      'production KFD Agent Runtime adapter is absent; rebuild core before freeze',
    );
  }
  fs.copyFileSync(source, path.join(distKfc, binaryName));
  fs.copyFileSync(
    path.join(
      CORE,
      'src',
      'kfd-agent-runtime',
      'kfd-agent-runtime.manifest.json',
    ),
    path.join(distKfc, 'kfd-agent-runtime.manifest.json'),
  );
  copyPdbSibling(source, distKfc);
  console.log('[freeze] KFD Agent Runtime adapter staged');
}

// BFS 查 build 树里首个匹配文件（返回最浅一份，避开 obj/临时深目录里的副本）。
/**
 * @param {string} root
 * @param {RegExp} re
 * @returns {string | null}
 */
function findFileShallow(root, re) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    const subdirs = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && re.test(e.name)) return full;
      if (e.isDirectory()) subdirs.push(full);
    }
    queue.push(...subdirs);
  }
  return null;
}

// Windows only：把 python binding(pykungfu)、libnode 运行库与窄 C ABI
// kungfu.dll 补拷进 dist/kungfu。
//
// 缘由：MSVC 多配置生成器与 Mac/Linux 单配置生成器的产物布局不一致——Win 把
// pykungfu.<abi>.pyd 产在 build/ 根、libnode.dll 产在 build/<bt>。组装树必须把两者
// 显式放进扁平 dist 根，供完整 CPython 与 Rust trunk 的 variant dispatch 使用。
// Mac/Linux 的 pykungfu.so 已位于 build/<bt>，且原生依赖由 origin-relative rpath 解析。
/** @param {string} bt */
function copyPyBindingWin(bt) {
  if (!isWin) return;
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const buildDir = path.join(CORE, 'build');
  const pyd = findFileShallow(buildDir, /^pykungfu.*\.pyd$/i);
  const btDll = path.join(buildDir, bt, 'libnode.dll');
  const dll = fs.existsSync(btDll)
    ? btDll
    : findFileShallow(buildDir, /^libnode\.dll$/i);
  // Python-free node launcher (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 3, Phase B): a plain SHARED lib
  // (no `.node` suffix). MSVC/cmake-js emits kungfu_node_host.dll at the build
  // root next to the .node addons and pykungfu.pyd; check the multi-config
  // build/<bt> subdir first (where libnode.dll lands) for resilience, then the
  // root. The trunk LoadLibraryW's it next to the exe for KUNGFU_AS_VARIANT=node
  // (variant.rs); absent → the Python variant path still runs node, so staging is
  // a fast-path, not a requirement.
  const btHost = path.join(buildDir, bt, 'kungfu_node_host.dll');
  const host = fs.existsSync(btHost)
    ? btHost
    : findFileShallow(buildDir, /^kungfu_node_host\.dll$/i);
  // Standard libkungfu ABI: the runtime DLL and its import library are both
  // required so the trunk and installed consumers can link and load the API.
  const btStorageDll = path.join(buildDir, bt, 'kungfu.dll');
  const storageDll = fs.existsSync(btStorageDll)
    ? btStorageDll
    : findFileShallow(buildDir, /^kungfu\.dll$/i);
  const btStorageImport = path.join(buildDir, bt, 'kungfu_abi.lib');
  const storageImport = fs.existsSync(btStorageImport)
    ? btStorageImport
    : findFileShallow(buildDir, /^kungfu_abi\.lib$/i);
  let n = 0;
  for (const src of [pyd, dll, host, storageDll, storageImport]) {
    if (!src) continue;
    fs.copyFileSync(src, path.join(distKfc, path.basename(src)));
    n++;
  }
  // pykungfu.pdb ships the symbols for the python binding + statically-linked
  // core; libnode.dll is third-party and carries no PDB of ours.
  if (pyd) copyPdbSibling(pyd, distKfc);
  if (host) copyPdbSibling(host, distKfc);
  if (storageDll) copyPdbSibling(storageDll, distKfc);
  if (!pyd) console.error('[freeze] Win 警告：build 树未找到 pykungfu*.pyd');
  if (!dll) console.error('[freeze] Win 警告：build 树未找到 libnode.dll');
  // Product builds must ship the Windows node host, or the trunk silently
  // degrades: no kungfu_node_host.dll → KUNGFU_AS_VARIANT=node falls back to the
  // Dev (bare `pnpm run freeze`) keeps warn-only.
  const missing = [];
  if (!host) {
    missing.push('kungfu_node_host.dll（node 变体会回退 Python 路径）');
  }
  if (missing.length) {
    const label = requireNativeHost ? '错误' : '提示';
    console.error(
      `[freeze] Win ${label}：build 树未找到 ${missing.join('、')}`,
    );
    if (requireNativeHost) {
      console.error(
        '[freeze] Win：产品构建要求原生 host（core 应以 node runtime 构建产出）。',
      );
      process.exit(1);
    }
  }
  if (!storageDll)
    console.error('[freeze] Win 错误：build 树未找到 kungfu.dll');
  if (!storageImport)
    console.error('[freeze] Win 错误：build 树未找到 kungfu_abi.lib');
  if (!storageDll || !storageImport) process.exit(1);
  console.log(
    `[freeze] Win：补拷 python binding / native hosts / SDK ABI → dist/kungfu：${n} 项`,
  );
}

// --------------------------------------------------------------- assemble
//
// KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 2: the host runs a complete, exact CPython tree. The assembled
// dist keeps the flat dist/kungfu root (natives, contract, wheels) and adds the interpreter
// tree under dist/kungfu/python. The kungfu package ships as sources at the
// dist root, wired into the tree through a site-packages .pth (never through
// PYTHON* environment variables, which would leak into satellite envs). The
// tree carries a kungfu-host.json marker so kungfu.host detects the assembled
// form; the product entry binary is wired by the entry-form step.

// uv names python-build-standalone keys with its own os/arch vocabulary; keep
// the mapping identical to kungfu-trunk's python_request (crates/trunk).
/** @param {string} pin */
function pbsKey(pin) {
  /** @type {Record<string, string>} */
  const osNames = { darwin: 'macos', win32: 'windows', linux: 'linux' };
  /** @type {Record<string, string>} */
  const architectures = { arm64: 'aarch64', x64: 'x86_64' };
  const osName = osNames[process.platform];
  const arch = architectures[process.arch];
  if (!osName || !arch) {
    console.error(
      `[freeze] assemble: unsupported platform ${process.platform}/${process.arch}`,
    );
    process.exit(1);
  }
  // The trailing segment is the key's libc field: none on macOS/Windows,
  // gnu on Linux (the product targets glibc). Keep identical to the trunk's
  // python_request (crates/trunk/src/envs.rs).
  const libc = process.platform === 'linux' ? 'gnu' : 'none';
  return `cpython-${pin}-${osName}-${arch}-${libc}`;
}

// PYTHON_PIN comes from the product pins manifest — the same single source the
// trunk reads at runtime, so the assembled tree and satellite envs can never
// drift apart. dist.mjs already asserts the manifest against .uv-version.
function readRuntimePins() {
  const pinsPath = path.join(CORE, '..', '..', 'product', 'runtime-pins.env');
  /** @type {Record<string, string>} */
  const pins = {};
  // Split on CRLF or LF: a Windows checkout with core.autocrlf=true renders the
  // committed LF file as CRLF, and a trailing \r would defeat the value match.
  for (const line of fs.readFileSync(pinsPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) pins[m[1]] = m[2];
  }
  if (!pins.PYTHON_PIN) {
    console.error(`[freeze] assemble: PYTHON_PIN missing in ${pinsPath}`);
    process.exit(1);
  }
  return pins;
}

// Materialize the pinned python-build-standalone prefix in the kungfu cache
// (same layout the trunk uses: UV_PYTHON_INSTALL_DIR under ~/.cache/kungfu),
// arch-qualified so a foreign-arch install can never satisfy the request.
/** @param {string} pin */
function ensureRuntimeTree(pin) {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  const installDir = path.join(cache, 'kungfu', 'python');
  const key = pbsKey(pin);
  shell.run('uv', ['python', 'install', key], true, {
    cwd: CORE,
    env: {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: installDir,
      UV_PYTHON_PREFERENCE: 'only-managed',
    },
  });
  const prefix = path.join(installDir, key);
  if (!fs.existsSync(prefix)) {
    console.error(`[freeze] assemble: expected runtime tree at ${prefix}`);
    process.exit(1);
  }
  return prefix;
}

// The stdlib prune policy is a declarative manifest, not code: a fixed list of
// prefix-relative paths subtracted from a complete stdlib. New dependencies
// live in site-packages and never interact with this list, and a stale entry
// fails safe (ships a few extra MB) — deliberately unlike the nofollow-import
// surface this stage retires. A pruned entry that is unexpectedly absent stops
// the build: the manifest must describe the tree it prunes.
/** @param {string} treeRoot */
function applyStdlibPrune(treeRoot) {
  const manifestPath = path.join(
    CORE,
    '..',
    '..',
    'product',
    'stdlib-prune.json',
  );
  if (!fs.existsSync(manifestPath)) {
    console.log('[freeze] assemble: no stdlib-prune manifest, full tree ships');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const sections = manifest.prune || {};
  const entries = [
    ...(sections.common || []),
    ...(sections[process.platform] || []),
  ];
  const root = path.resolve(treeRoot);
  let n = 0;
  for (const rel of entries) {
    // '*' globs cover version-suffixed names (pip-<ver>.dist-info); a literal
    // or glob that matches nothing means the manifest no longer describes the
    // tree it prunes, which stops the build.
    const matches = rel.includes('*')
      ? fs.globSync(rel, { cwd: treeRoot })
      : [rel];
    if (!matches.length) {
      console.error(`[freeze] assemble: prune glob matches nothing: ${rel}`);
      process.exit(1);
    }
    for (const m of matches) {
      const target = path.resolve(treeRoot, m);
      if (!target.startsWith(root + path.sep)) {
        console.error(
          `[freeze] assemble: prune entry escapes the tree: ${rel}`,
        );
        process.exit(1);
      }
      if (!existsLstat(target)) {
        console.error(`[freeze] assemble: prune entry not in the tree: ${rel}`);
        process.exit(1);
      }
      fs.rmSync(target, { recursive: true, force: true });
      n++;
    }
  }
  console.log(
    `[freeze] assemble: pruned ${n} paths (${entries.length} entries)`,
  );
}

// Natives the frozen leg bundled by following imports (pykungfu and the
// libraries its rpath colocation expects) must be staged explicitly here;
// the four app-side .node files keep going through copyAppNative.
/** @param {string} bt @param {string} distKfc */
function copyRuntimeNative(bt, distKfc) {
  const rel = path.join(CORE, 'build', bt);
  // libkungfu.* also stages the libkungfu-family natives (libwasm runtimes, and
  // the Python-free node launcher libkungfu_node_host — KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 3), which
  // ship next to the front door so the trunk can dlopen the launcher and run the
  // node variant without booting CPython.
  const wanted =
    /^(pykungfu.*\.(so|pyd)|libkungfu.*|libnode.*|libnodebuildinfo\.json)$/i;
  let n = 0;
  let hostStaged = false;
  for (const f of fs.readdirSync(rel)) {
    if (!wanted.test(f)) continue;
    if (/^libkungfu_node_host\./i.test(f)) hostStaged = true;
    fs.copyFileSync(path.join(rel, f), path.join(distKfc, f));
    n++;
  }
  if (!n) {
    console.error(`[freeze] assemble: no runtime natives under build/${bt}`);
    process.exit(1);
  }
  // Product builds must ship the Python-free node launcher; the core is built for
  // the node runtime, so its absence means the host build silently failed and the
  // node variant would fall back to the slow Python path.
  if (requireNativeHost && !hostStaged) {
    console.error(
      `[freeze] assemble: 产品构建要求原生 node-host（libkungfu_node_host.*），但 build/${bt} 未找到——core 应以 node runtime 构建产出它；缺席会让 KUNGFU_AS_VARIANT=node 退回慢 Python 路径。`,
    );
    process.exit(1);
  }
  console.log(`[freeze] assemble: staged ${n} runtime natives`);
}

// python-build-standalone lays the prefix out differently by OS, so the seams
// that touch the interpreter (the install-target python, the site-packages
// home, the .pth climb back to the flat dist root) fork here. POSIX keeps
// bin/python3 + lib/pythonX.Y/site-packages; Windows keeps python.exe at the
// prefix root + Lib/site-packages (capital L, no version subdir). The .pth
// counts directories from site-packages up to dist/kungfu: four on POSIX
// (site-packages → pythonX.Y → lib → python → kungfu), three on Windows
// (site-packages → Lib → python → kungfu).
/** @param {string} treeDest @param {string} feature */
function assembleLayout(treeDest, feature) {
  return isWin
    ? {
        python: path.join(treeDest, 'python.exe'),
        sitePackages: path.join(treeDest, 'Lib', 'site-packages'),
        pthToRoot: '../../..',
      }
    : {
        python: path.join(treeDest, 'bin', 'python3'),
        sitePackages: path.join(
          treeDest,
          'lib',
          `python${feature}`,
          'site-packages',
        ),
        pthToRoot: '../../../..',
      };
}

/** @param {string} bt */
function assembleTree(bt) {
  const pins = readRuntimePins();
  const pin = pins.PYTHON_PIN;
  const feature = pin.split('.').slice(0, 2).join('.');
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const info = ensureBuildInfo(bt);
  const prefix = ensureRuntimeTree(pin);

  console.log(`[freeze] assemble: ${pbsKey(pin)} → dist/kungfu/python`);
  fs.rmSync(distKfc, { recursive: true, force: true });
  fs.mkdirSync(distKfc, { recursive: true });

  const treeDest = path.join(distKfc, 'python');
  fs.cpSync(prefix, treeDest, { recursive: true, verbatimSymlinks: true });
  applyStdlibPrune(treeDest);
  const layout = assembleLayout(treeDest, feature);

  // Runtime dependencies resolve from the committed lock into the tree's own
  // site-packages — the host tree is the blessed interpreter, so its deps are
  // part of the product image, not a satellite env concern.
  const req = path.join(CORE, 'build', 'assemble-requirements.txt');
  shell.run(
    'uv',
    ['export', '--frozen', '--no-dev', '--no-emit-project', '-o', req],
    true,
    { cwd: CORE },
  );
  // The tree keeps python-build-standalone's EXTERNALLY-MANAGED marker: in the
  // product it guards the kungfu-owned install surface (a stray pip into the
  // host tree gets refused, KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 violation 5). The build stages the deps
  // through the one explicit bypass.
  shell.run(
    'uv',
    [
      'pip',
      'install',
      '--python',
      layout.python,
      '--break-system-packages',
      '-r',
      req,
    ],
    true,
    { cwd: CORE },
  );

  // The kungfu package ships as sources in the tree's site-packages — the
  // standard home, and the dist root stays free for the product entry named
  // `kungfu`. Data files (.bfbs schemas, the agent pack) travel inside the
  // package, where the source layout already has them. The .pth wires the
  // flat dist root (pykungfu + natives) into the tree.
  fs.cpSync(
    path.join(CORE, 'src', 'python', 'kungfu'),
    path.join(layout.sitePackages, 'kungfu'),
    {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes('__pycache__'),
    },
  );
  // The wheel's build_py command stages the normative Exit contract beside
  // the registry-free verifier.  The assembled product copies Python sources
  // directly, so it must make the same package-data promise explicitly.
  fs.copyFileSync(
    path.join(CORE, '..', 'exit', 'kungfu-exit-bundle.contract.json'),
    path.join(layout.sitePackages, 'kungfu', 'exit_bundle.contract.json'),
  );
  copyWorkProfileConformance(
    path.join(layout.sitePackages, 'kungfu', 'work_profile_conformance'),
  );
  copyWorkDesignRuntime(
    path.join(layout.sitePackages, 'kungfu', 'work_design_runtime'),
  );
  const documentationDestination = path.join(
    layout.sitePackages,
    'kungfu',
    'agent',
    'documentation',
  );
  fs.cpSync(documentationAtlasSource(), documentationDestination, {
    recursive: true,
  });
  const portableBundle = portableAtlasBundleSource();
  fs.copyFileSync(
    portableBundle.manifestPath,
    path.join(documentationDestination, 'bundle.json'),
  );
  fs.copyFileSync(
    portableBundle.classificationPath,
    path.join(documentationDestination, 'classification.json.gz'),
  );
  // Assignment orchestration is an installed-product surface. Its Work
  // Control Profile must therefore travel with the runtime instead of being
  // resolved from a developer checkout at admission time.
  copyFirstPartyProfile(
    path.resolve(CORE, '..', '..', 'extensions', 'work-control'),
    path.join(layout.sitePackages, 'kungfu', 'profiles', 'work-control'),
  );
  copyFirstPartyProfile(
    path.resolve(CORE, '..', '..', 'extensions', 'dogfood'),
    path.join(layout.sitePackages, 'kungfu', 'profiles', 'dogfood'),
  );
  fs.copyFileSync(
    path.resolve(CORE, '..', '..', '.xinfa', 'product-documentation-pack.json'),
    path.join(
      layout.sitePackages,
      'kungfu',
      'agent',
      'documentation-selector.json',
    ),
  );
  console.log(
    '[freeze] assemble: verified Documentation Atlas + first-party Profiles staged',
  );
  fs.copyFileSync(info, path.join(distKfc, 'kungfubuildinfo.json'));

  fs.writeFileSync(
    path.join(layout.sitePackages, 'kungfu-dist.pth'),
    `${layout.pthToRoot}\n`,
  );
  fs.writeFileSync(
    path.join(treeDest, 'kungfu-host.json'),
    `${JSON.stringify(
      { schema: 'kungfu.host/v1', form: 'assembled', product_root: '..' },
      null,
      2,
    )}\n`,
  );

  // Native staging follows the MSVC-vs-single-config split: on Windows the
  // python binding (pykungfu.pyd, core statically linked) sits at build/ root
  // and libnode.dll at build/<bt>, so the Windows-aware helper (also its PDB)
  // stages them; POSIX natives colocate under build/<bt> with rpath, so the
  // flat copy suffices.
  if (isWin) copyPyBindingWin(bt);
  else copyRuntimeNative(bt, distKfc);
  copyAppNative(bt);
  copyLibwasmRuntime();
  copyKfdAgentRuntime(bt);
  copyConfigContract();
  stageEntry(distKfc, bt);
  generateHelpManifest(layout.python, distKfc);
  console.log(
    '[freeze] ✅ dist/kungfu assembled (interpreter tree + flat natives + ' +
      'trunk entry)',
  );
}

// Introspect the assembled click tree into the declarative help manifest the
// trunk renders for `kungfu --help` without booting Python (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 4).
// The manifest is generated from the live CLI (kungfu.cli.help_manifest), so it
// is the single source of truth and cannot drift. Generation is mandatory for
// an assembled product: the same manifest now owns native root-option routing,
// so silently falling back would make `kungfu -H <home> fsck` depend on Python.
/** @param {string} pythonExe @param {string} distKfc */
function generateHelpManifest(pythonExe, distKfc) {
  const out = path.join(distKfc, 'help-manifest.txt');
  try {
    const text = cp.execFileSync(
      pythonExe,
      ['-m', 'kungfu.cli.help_manifest'],
      { cwd: distKfc, encoding: 'utf8' },
    );
    fs.writeFileSync(out, text);
    console.log('[freeze] assemble: staged help-manifest.txt');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[freeze] assemble: help/root-routing manifest generation failed: ${message}`,
    );
  }
}

// The product entry is the trunk binary installed under the name `kungfu`:
// invoked as `kungfu` it parses the generated root contract, keeps the native
// subtrees in its dispatch table, and
// execs the assembled interpreter on -m kungfu for everything else, verbatim
// (crates/trunk/src/launch.rs). Staged here so a bare `pnpm run freeze`
// yields a runnable assembled dist; dist.mjs stageTrunk later re-stages
// kungfu-trunk and asserts pins consistency at the product stage — same
// commit, same profile, same binary.
// The product trunk links the standard bootstrap and ships the real stream-backed
// `doctor` on every platform (--features embedding). POSIX links the SHARED
// libkungfu directly from build/<bt>; Windows links the standard-ABI
// kungfu_abi.lib from the build root, where MSVC archives colocate. The native dir is
// passed explicitly so build.rs never has to guess a relative path that could
// fail canonicalize under CI.
/** @param {string} distKfc @param {string} bt */
function stageEntry(distKfc, bt) {
  const crates = path.join(CORE, '..', '..', 'crates');
  const cargoArgs = [
    'build',
    '--release',
    '-p',
    'kungfu-trunk',
    '--features',
    'embedding',
  ];
  const runOpts = {
    cwd: crates,
    env: {
      ...process.env,
      // Windows: kungfu_abi.lib at the build root; POSIX: libkungfu.* under build/<bt>.
      KF_TRUNK_NATIVE_DIR: isWin
        ? path.join(CORE, 'build')
        : path.join(CORE, 'build', bt),
      KF_TRUNK_BUILD_TYPE: bt,
    },
  };
  shell.run('cargo', cargoArgs, true, runOpts);
  const built = path.join(
    crates,
    'target',
    'release',
    isWin ? 'kungfu-trunk.exe' : 'kungfu-trunk',
  );
  for (const name of ['kungfu-trunk', 'kungfu']) {
    fs.copyFileSync(built, path.join(distKfc, isWin ? `${name}.exe` : name));
  }
  fs.copyFileSync(
    path.join(CORE, '..', '..', 'product', 'runtime-pins.env'),
    path.join(distKfc, 'runtime-pins.env'),
  );
  console.log('[freeze] assemble: trunk entry staged as kungfu + kungfu-trunk');
}

/** @param {string} p */
function existsLstat(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// pykungfu wheel 随 dist 发布：wheel 由 gyp 链的 wheel 目标先行构建
// (build/python/dist/*.whl)，freeze 后拷进 dist/kungfu/wheels/，产品装包面
// (kungfu env) 从产品目录内解析 wheel 装进卫星 env。直跑 `pnpm run freeze`
// （跳过 wheel 目标的 dev 捷径）时告警不失败；完整 gyp/dist 链恒先建 wheel。
function copyWheel() {
  const wheelSrc = path.join(CORE, 'build', 'python', 'dist');
  const wheelDest = path.join(CORE, 'dist', 'kungfu', 'wheels');
  const wheels = fs.existsSync(wheelSrc)
    ? fs.readdirSync(wheelSrc).filter((f) => f.endsWith('.whl'))
    : [];
  if (!wheels.length) {
    console.warn(
      '[freeze] ! build/python/dist 无 wheel（dev 捷径？完整链请经 gyp wheel 目标）；' +
        'dist/kungfu/wheels 缺失将使产品装包面不可用',
    );
    return;
  }
  fs.mkdirSync(wheelDest, { recursive: true });
  for (const f of wheels) {
    fs.copyFileSync(path.join(wheelSrc, f), path.join(wheelDest, f));
  }
  console.log(`[freeze] wheel 进 dist：${wheels.join(', ')}`);
}

function main() {
  const bt = buildType();
  const selector = requireAssemblySelector(assemblySelector());
  console.log(`[freeze] product_form=${selector} build_type=${bt}`);
  assembleTree(bt);
  copyWheel();
}

if (require.main === module) main();

module.exports = {
  assemblySelector,
  copyFirstPartyProfile,
  copyWorkDesignRuntime,
  copyWorkProfileConformance,
  documentationAtlasSource,
  firstPartyProfileFilter,
  portableAtlasBundleSource,
  requireAssemblySelector,
};
