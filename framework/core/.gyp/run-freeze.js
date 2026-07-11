// SPDX-License-Identifier: Apache-2.0
//
// Stage C kfc freeze 独立入口（脱 conan2；对应迁移文档 D6 + Stage C wiring）。
//
// 背景：conan2 移除了独立 `conan package` 本地命令，原 `freeze`→run-conan.js package
// 只触发 `conan build`（占位，不跑 freezer）。本脚本把 freeze 做成 `./shifu freeze`
// 一步可复现，并据 `config.freezer` 选择产物腿；缺省全平台 assemble（ADR-0046
// stage 2 已逐平台收口：macOS→Linux→Windows 全部组装完整 CPython 树）。冻结腿
// （nuitka/pyinstaller）随最后平台退役，去留记账见 docs/buildchain.md。
//
// 三条产物腿（assemble 见 ADR-0046 与本文件 assemble 段注释；冻结腿去留记账见
// docs/buildchain.md「Freeze retirement ledger」）：
//
// - nuitka（默认）：编译成 C，产物 kungfu_cli.dist 本就扁平（无 _internal），移到 dist/kungfu 即可，
//   不需要 promote。kungfu_cli.py 内嵌 nuitka-project 选项（--standalone 等）。Nuitka 只跟随
//   kungfu_cli.py 的 import，故 app/electron 侧 node native（drone.node / kungfu_node.node /
//   kungfu_electron.node）需 freeze 后从 build/<type> 补拷（kfc python 进程不 import 它们）。
// - pyinstaller（fallback）：onedir 把数据/库放进 _internal/，而 app 栈假设 dist/kungfu 扁平，
//   故 freeze 后 promote（_internal/*→顶层，Unix 符号链/Win 拷贝）。
// @ts-check

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shell } = require('../lib');
const { verifyWindowsSymbols } = require('./verify-windows-symbols');

const CORE = path.resolve(__dirname, '..'); // framework/core
const isWin = process.platform === 'win32';
const { copyContractArtifacts } = require(
  path.join(CORE, '..', '..', 'scripts', 'contract-registry.cjs'),
);

function copyConfigContract() {
  copyContractArtifacts(path.join(CORE, 'dist', 'kungfu'));
}

function buildType() {
  return shell.getConfigValue('build_type') || 'Release';
}

function freezer() {
  // ADR-0046 stage 2 rolled out platform by platform and is now complete:
  // macOS, Linux, and Windows all ship the assembled runtime. The frozen legs
  // retire with this last platform (docs/buildchain.md「Freeze retirement
  // ledger」). An explicit config value can still select any surviving leg.
  const explicit = shell.getConfigValue('freezer');
  if (explicit) return explicit;
  return 'assemble';
}

// kungfu.spec datas 引用 build/include 与 build/libs（仅 pyinstaller 路径需要）。
// 头文件按 target 归属分布在各库目录下，staging 时合并成单一 include 树。
function stage() {
  const includeRoots = ['libyijinjing', 'libkungfu'].map((lib) =>
    path.join(CORE, 'src', lib, 'include'),
  );
  const buildInc = path.join(CORE, 'build', 'include');
  console.log('[freeze] staging: src/lib*/include → build/include');
  fs.rmSync(buildInc, { recursive: true, force: true });
  for (const inc of includeRoots) {
    fs.cpSync(inc, buildInc, { recursive: true });
  }
  fs.mkdirSync(path.join(CORE, 'build', 'libs'), { recursive: true });
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

// app/electron 侧 node native：kfc python 进程不 import，Nuitka 不带，需从 build/<type> 补拷。
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
  const rel = path.join(CORE, 'build', bt);
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  let n = 0;
  for (const f of APP_NATIVE) {
    const from = path.join(rel, f);
    if (!fs.existsSync(from)) continue;
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

// Windows only：把 python binding(pykungfu) 与 libnode 运行库补拷进 dist/kungfu。
//
// 缘由：MSVC 多配置生成器与 Mac/Linux 单配置生成器的产物布局不一致——Win 把
// pykungfu.<abi>.pyd 产在 build/ 根、libnode.dll 产在 build/<bt>；而 Nuitka freeze 用
// PYTHONPATH=build/<bt> 跟随 `import pykungfu`，于是在 Win 上既找不到 pykungfu(.pyd 不在
// build/<bt>)、也不会连带 libnode.dll(非 pykungfu 同目录、Py3.8+ 扩展模块 DLL 依赖也不认
// PATH)，冻结 kfc 运行时 `import pykungfu` 报 ModuleNotFound / DLL load failed。
// Mac/Linux 无此问题：pykungfu.so 就在 build/<bt>，其 libnode 依赖经 rpath(@loader_path/
// $ORIGIN) 解析、Nuitka 依赖扫描连带打包，故 freeze 自洽（本函数在非 Win 直接返回）。
// 冻结 kfc 可执行会加载与其同目录的 pykungfu.pyd + libnode.dll（已实测通过），故补拷即可。
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
  let n = 0;
  for (const src of [pyd, dll]) {
    if (!src) continue;
    fs.copyFileSync(src, path.join(distKfc, path.basename(src)));
    n++;
  }
  // pykungfu.pdb ships the symbols for the python binding + statically-linked
  // core; libnode.dll is third-party and carries no PDB of ours.
  if (pyd) copyPdbSibling(pyd, distKfc);
  if (!pyd) console.error('[freeze] Win 警告：build 树未找到 pykungfu*.pyd');
  if (!dll) console.error('[freeze] Win 警告：build 树未找到 libnode.dll');
  console.log(`[freeze] Win：补拷 python binding → dist/kungfu：${n} 项`);
}

// ----------------------------------------------------------------- nuitka

/** @param {string} bt */
function freezeNuitka(bt) {
  const rel = path.join(CORE, 'build', bt); // 三 native（pykungfu/libkungfu/libnode）同目录
  const out = path.join(CORE, 'build', 'kungfu-nuitka');
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const info = ensureBuildInfo(bt);

  console.log(
    `[freeze] nuitka kungfu_cli.py（PYTHONPATH=${path.relative(CORE, rel)}）`,
  );
  fs.rmSync(out, { recursive: true, force: true });
  // Linux 强制 clang 后端：gcc 13 编译 nuitka 生成的 scipy 巨型 C 文件会触发 internal
  // compiler error(cfgcleanup.cc try_forward_edges ICE)。Mac 本就默认 clang、不撞，故仅
  // Linux 切 clang，顺带让两平台 freeze 用同一 C 编译器、跨机更一致。需机器装 clang。
  const clangOpt = process.platform === 'linux' ? ['--clang'] : [];
  shell.run(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      '-m',
      'nuitka',
      ...clangOpt,
      '--output-dir=build/kungfu-nuitka',
      // `kungfu trace -- <cmd>` spawns arbitrary child commands; some (e.g.
      // `sh -c ...`) carry a `-c` argument that Nuitka's deployment mode
      // mistakes for the frozen binary being asked to self-execute. The runtime
      // never re-executes itself, so disabling this guard is safe.
      '--no-deployment-flag=self-execution',
      `--include-data-files=${info}=kungfubuildinfo.json`,
      // Fact-ledger schema blobs: the kungfu package's *_events.bfbs are read at
      // runtime (rewind/atlas/work) but Nuitka does not follow non-.py package
      // data, so ship them flat next to the binding where schema_data_path falls
      // back to when the compiled module dir is not a real directory.
      ...['rewind', 'atlas', 'work'].map(
        (m) =>
          `--include-data-files=${path.join(CORE, 'src', 'python', 'kungfu', m, `${m}_events.bfbs`)}=${m}_events.bfbs`,
      ),
      ...agentPackDataArgs(),
      path.join('src', 'python', 'kungfu_cli.py'),
    ],
    true,
    { cwd: CORE, env: { ...process.env, PYTHONPATH: rel } },
  );

  // Nuitka standalone 产物 kungfu_cli.dist 本就扁平 → 直接移到 dist/kungfu（无 _internal、无 promote）。
  const kfcDist = path.join(out, 'kungfu_cli.dist');
  if (!fs.existsSync(kfcDist)) {
    console.error(`[freeze] 错误：未找到 ${kfcDist}（nuitka 产物布局变化？）`);
    process.exit(1);
  }
  fs.rmSync(distKfc, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(distKfc), { recursive: true });
  fs.renameSync(kfcDist, distKfc);

  // nuitka standalone 入口名为 kungfu_cli.bin(Unix)/kungfu.exe(Win)；app 栈按 'kungfu'(Unix)/'kungfu.exe'(Win)
  // 定位可执行（framework/api pathConfig/processUtils 的 kungfuName）。把 nuitka 入口重命名为
  // kungfu（用 rename 不用符号链，保持 nuitka 产物无符号链、electron-builder 打包干净）。
  if (!isWin) {
    const binPath = path.join(distKfc, 'kungfu_cli.bin');
    const kungfuPath = path.join(distKfc, 'kungfu');
    if (fs.existsSync(binPath)) fs.renameSync(binPath, kungfuPath);
  } else {
    const exePath = path.join(distKfc, 'kungfu_cli.exe');
    const kungfuExe = path.join(distKfc, 'kungfu.exe');
    if (fs.existsSync(exePath)) fs.renameSync(exePath, kungfuExe);
  }

  copyAppNative(bt);
  copyPyBindingWin(bt);
  copyLibwasmRuntime();
  copyConfigContract();
  if (isWin) verifyWindowsSymbols(path.join(CORE, 'dist', 'kungfu'));
  console.log('[freeze] ✅ dist/kungfu 就绪（nuitka 扁平产物 + app native）');
}

// --------------------------------------------------------------- assemble
//
// ADR-0046 stage 2: the host runs a complete, exact CPython tree instead of a
// frozen subset. The assembled dist keeps the flat dist/kungfu root (natives,
// contract, wheels — identical to the frozen layout) and adds the interpreter
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
  for (const line of fs.readFileSync(pinsPath, 'utf-8').split('\n')) {
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
  const wanted =
    /^(pykungfu.*\.(so|pyd)|libkungfu.*|libnode.*|libnodebuildinfo\.json)$/i;
  let n = 0;
  for (const f of fs.readdirSync(rel)) {
    if (!wanted.test(f)) continue;
    fs.copyFileSync(path.join(rel, f), path.join(distKfc, f));
    n++;
  }
  if (!n) {
    console.error(`[freeze] assemble: no runtime natives under build/${bt}`);
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
  // host tree gets refused, ADR-0046 violation 5). The build stages the deps
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
  copyConfigContract();
  stageEntry(distKfc);
  console.log(
    '[freeze] ✅ dist/kungfu assembled (interpreter tree + flat natives + ' +
      'trunk entry)',
  );
}

// The product entry is the trunk binary installed under the name `kungfu`:
// invoked as `kungfu` it keeps the subtrees it implements (env, prewarm) and
// execs the assembled interpreter on -m kungfu for everything else, verbatim
// (crates/trunk/src/launch.rs). Staged here so a bare `pnpm run freeze`
// yields a runnable assembled dist; dist.mjs stageTrunk later re-stages
// kungfu-trunk and asserts pins consistency at the product stage — same
// commit, same profile, same binary.
/** @param {string} distKfc */
function stageEntry(distKfc) {
  const crates = path.join(CORE, '..', '..', 'crates');
  shell.run('cargo', ['build', '--release', '-p', 'kungfu-trunk'], true, {
    cwd: crates,
  });
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

// ------------------------------------------------------------- pyinstaller

/** @param {string} bt */
function freezePyinstaller(bt) {
  stage();
  ensureBuildInfo(bt);
  console.log(`[freeze] pyinstaller kungfu.spec (CMAKE_BUILD_TYPE=${bt})`);
  fs.rmSync(path.join(CORE, 'dist'), { recursive: true, force: true });
  shell.run(
    'uv',
    [
      'run',
      '--frozen',
      'pyinstaller',
      '--workpath=build',
      '--distpath=dist',
      '--clean',
      '--noconfirm',
      path.join('src', 'python', 'kungfu.spec'),
    ],
    true,
    {
      cwd: CORE,
      env: {
        ...process.env,
        CMAKE_BUILD_TYPE: bt,
        KUNGFU_PYI_HOOKS_PATH: path.join(CORE, 'src', 'python', 'pyi-hooks'),
      },
    },
  );
  promote();
  copyLibwasmRuntime();
  copyConfigContract();
  if (isWin) verifyWindowsSymbols(path.join(CORE, 'dist', 'kungfu'));
  console.log(
    '[freeze] ✅ dist/kungfu 就绪（pyinstaller 扁平视图 + _internal 真身）',
  );
}

// _internal/* 在 dist/kungfu 顶层补一层视图，满足 app 栈的扁平布局假设（仅 pyinstaller 路径）。
function promote() {
  const distKfc = path.join(CORE, 'dist', 'kungfu');
  const internal = path.join(distKfc, '_internal');
  if (!fs.existsSync(internal)) {
    console.error(
      `[freeze] 错误：未找到 ${internal}（PyInstaller onedir 布局变化？）`,
    );
    process.exit(1);
  }
  console.log(
    `[freeze] promote _internal/* → 顶层（${isWin ? '拷贝' : '符号链'}）`,
  );
  let n = 0;
  for (const entry of fs.readdirSync(internal)) {
    const top = path.join(distKfc, entry);
    if (existsLstat(top)) continue; // 跳过 pyinstaller 已放在顶层的项（kfc exe 等）
    if (isWin) {
      fs.cpSync(path.join(internal, entry), top, { recursive: true });
    } else {
      fs.symlinkSync(path.join('_internal', entry), top);
    }
    n++;
  }
  console.log(`[freeze] promote 完成：${n} 项`);
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
      '[freeze] ⚠️ build/python/dist 无 wheel（dev 捷径？完整链请经 gyp wheel 目标）；' +
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
  const fz = freezer();
  console.log(`[freeze] freezer=${fz} build_type=${bt}`);
  if (fz === 'nuitka') {
    freezeNuitka(bt);
  } else if (fz === 'pyinstaller') {
    freezePyinstaller(bt);
  } else if (fz === 'assemble') {
    assembleTree(bt);
  } else {
    console.error(
      `[freeze] 未知 freezer: ${fz}（应为 nuitka、pyinstaller 或 assemble）`,
    );
    process.exit(1);
  }
  copyWheel();
}

main();
