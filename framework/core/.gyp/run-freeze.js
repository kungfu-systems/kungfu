// SPDX-License-Identifier: Apache-2.0
//
// Stage C kfc freeze 独立入口（脱 conan2；对应迁移文档 D6 + Stage C wiring）。
//
// 背景：conan2 移除了独立 `conan package` 本地命令，原 `freeze`→run-conan.js package
// 只触发 `conan build`（占位，不跑 freezer）。本脚本把 freeze 做成 `./kungfu-code freeze`
// 一步可复现，并据 `config.freezer` 选择 Nuitka（默认）或 PyInstaller（fallback）。
//
// 两条 freezer 路径（可人 2026-06-17 决策 Nuitka 2.x，不行回退 PyInstaller；
// .v4 线 Nuitka 三平台已跑通，见 docs/conan2-migration.md §4c）：
//
// - nuitka（默认）：编译成 C，产物 kungfu_cli.dist 本就扁平（无 _internal），移到 dist/kungfu 即可，
//   不需要 promote。kungfu_cli.py 内嵌 nuitka-project 选项（--standalone 等）。Nuitka 只跟随
//   kungfu_cli.py 的 import，故 app/electron 侧 node native（drone.node / kungfu_node.node /
//   kungfu_electron.node）需 freeze 后从 build/<type> 补拷（kfc python 进程不 import 它们）。
// - pyinstaller（fallback）：onedir 把数据/库放进 _internal/，而 app 栈假设 dist/kungfu 扁平，
//   故 freeze 后 promote（_internal/*→顶层，Unix 符号链/Win 拷贝）。
// @ts-check

const fs = require('fs');
const path = require('path');
const { shell } = require('../lib');
const { verifyWindowsSymbols } = require('./verify-windows-symbols');

const CORE = path.resolve(__dirname, '..'); // framework/core
const isWin = process.platform === 'win32';

function buildType() {
  return shell.getConfigValue('build_type') || 'Release';
}

function freezer() {
  return shell.getConfigValue('freezer') || 'nuitka';
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
    const exePath = path.join(distKfc, 'kungfu.exe');
    const kungfuExe = path.join(distKfc, 'kungfu.exe');
    if (fs.existsSync(exePath)) fs.renameSync(exePath, kungfuExe);
  }

  copyAppNative(bt);
  copyPyBindingWin(bt);
  if (isWin) verifyWindowsSymbols(path.join(CORE, 'dist', 'kungfu'));
  console.log('[freeze] ✅ dist/kungfu 就绪（nuitka 扁平产物 + app native）');
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

function main() {
  const bt = buildType();
  const fz = freezer();
  console.log(`[freeze] freezer=${fz} build_type=${bt}`);
  if (fz === 'nuitka') {
    freezeNuitka(bt);
  } else if (fz === 'pyinstaller') {
    freezePyinstaller(bt);
  } else {
    console.error(`[freeze] 未知 freezer: ${fz}（应为 nuitka 或 pyinstaller）`);
    process.exit(1);
  }
}

main();
