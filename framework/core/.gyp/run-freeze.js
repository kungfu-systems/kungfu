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
// - nuitka（默认）：编译成 C，产物 kfc.dist 本就扁平（无 _internal），移到 dist/kfc 即可，
//   不需要 promote。kfc.py 内嵌 nuitka-project 选项（--standalone 等）。Nuitka 只跟随
//   kfc.py 的 import，故 app/electron 侧 node native（drone.node / kungfu_node.node /
//   kungfu_electron.node）需 freeze 后从 build/<type> 补拷（kfc python 进程不 import 它们）。
// - pyinstaller（fallback）：onedir 把数据/库放进 _internal/，而 app 栈假设 dist/kfc 扁平，
//   故 freeze 后 promote（_internal/*→顶层，Unix 符号链/Win 拷贝）。

const fs = require('fs');
const path = require('path');
const { shell } = require('../lib');

const CORE = path.resolve(__dirname, '..'); // framework/core
const isWin = process.platform === 'win32';

function buildType() {
  return shell.getConfigValue('build_type') || 'Release';
}

function freezer() {
  return shell.getConfigValue('freezer') || 'nuitka';
}

// kfc.spec datas 引用 build/include 与 build/libs（仅 pyinstaller 路径需要）。
function stage() {
  const srcInc = path.join(CORE, 'src', 'include');
  const buildInc = path.join(CORE, 'build', 'include');
  console.log('[freeze] staging: src/include → build/include');
  fs.rmSync(buildInc, { recursive: true, force: true });
  fs.cpSync(srcInc, buildInc, { recursive: true });
  fs.mkdirSync(path.join(CORE, 'build', 'libs'), { recursive: true });
}

// kungfu/__init__ 读 pykungfu 同目录的 kungfubuildinfo.json 取 version；缺则生成。
function ensureBuildInfo(bt) {
  const dir = path.join(CORE, 'build', bt);
  const info = path.join(dir, 'kungfubuildinfo.json');
  if (fs.existsSync(info)) return info;
  console.log(`[freeze] buildinfo 缺失，生成 → ${info}`);
  fs.mkdirSync(dir, { recursive: true });
  shell.run(
    'uv',
    ['run', '--frozen', 'python3', path.join(CORE, '.gyp', 'gen_kungfubuildinfo.py'), info],
    true,
    { cwd: CORE },
  );
  return info;
}

// app/electron 侧 node native：kfc python 进程不 import，Nuitka 不带，需从 build/<type> 补拷。
// app 栈通过 @kungfu-tech/core/dist/kfc/<x> 解析它们（getKfcDir / webpack require.resolve）。
const APP_NATIVE = [
  'drone.node',
  'kungfu_node.node',
  'kungfu_electron.node',
  'link_node.node',
];

function copyAppNative(bt) {
  const rel = path.join(CORE, 'build', bt);
  const distKfc = path.join(CORE, 'dist', 'kfc');
  let n = 0;
  for (const f of APP_NATIVE) {
    const from = path.join(rel, f);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(distKfc, f));
    n++;
  }
  console.log(`[freeze] 补拷 app native：${n}/${APP_NATIVE.length} 项`);
}

// BFS 查 build 树里首个匹配文件（返回最浅一份，避开 obj/临时深目录里的副本）。
function findFileShallow(root, re) {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
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

// Windows only：把 python binding(pykungfu) 与 libnode 运行库补拷进 dist/kfc。
//
// 缘由：MSVC 多配置生成器与 Mac/Linux 单配置生成器的产物布局不一致——Win 把
// pykungfu.<abi>.pyd 产在 build/ 根、libnode.dll 产在 build/<bt>；而 Nuitka freeze 用
// PYTHONPATH=build/<bt> 跟随 `import pykungfu`，于是在 Win 上既找不到 pykungfu(.pyd 不在
// build/<bt>)、也不会连带 libnode.dll(非 pykungfu 同目录、Py3.8+ 扩展模块 DLL 依赖也不认
// PATH)，冻结 kfc 运行时 `import pykungfu` 报 ModuleNotFound / DLL load failed。
// Mac/Linux 无此问题：pykungfu.so 就在 build/<bt>，其 libnode 依赖经 rpath(@loader_path/
// $ORIGIN) 解析、Nuitka 依赖扫描连带打包，故 freeze 自洽（本函数在非 Win 直接返回）。
// 冻结 kfc 可执行会加载与其同目录的 pykungfu.pyd + libnode.dll（已实测通过），故补拷即可。
function copyPyBindingWin(bt) {
  if (!isWin) return;
  const distKfc = path.join(CORE, 'dist', 'kfc');
  const buildDir = path.join(CORE, 'build');
  const pyd = findFileShallow(buildDir, /^pykungfu.*\.pyd$/i);
  const btDll = path.join(buildDir, bt, 'libnode.dll');
  const dll = fs.existsSync(btDll) ? btDll : findFileShallow(buildDir, /^libnode\.dll$/i);
  let n = 0;
  for (const src of [pyd, dll]) {
    if (!src) continue;
    fs.copyFileSync(src, path.join(distKfc, path.basename(src)));
    n++;
  }
  if (!pyd) console.error('[freeze] Win 警告：build 树未找到 pykungfu*.pyd');
  if (!dll) console.error('[freeze] Win 警告：build 树未找到 libnode.dll');
  console.log(`[freeze] Win：补拷 python binding → dist/kfc：${n} 项`);
}

// ----------------------------------------------------------------- nuitka

function freezeNuitka(bt) {
  const rel = path.join(CORE, 'build', bt); // 三 native（pykungfu/libkungfu/libnode）同目录
  const out = path.join(CORE, 'build', 'kfc-nuitka');
  const distKfc = path.join(CORE, 'dist', 'kfc');
  const info = ensureBuildInfo(bt);

  console.log(`[freeze] nuitka kfc.py（PYTHONPATH=${path.relative(CORE, rel)}）`);
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
      '--output-dir=build/kfc-nuitka',
      `--include-data-files=${info}=kungfubuildinfo.json`,
      path.join('src', 'python', 'kfc.py'),
    ],
    true,
    { cwd: CORE, env: { ...process.env, PYTHONPATH: rel } },
  );

  // Nuitka standalone 产物 kfc.dist 本就扁平 → 直接移到 dist/kfc（无 _internal、无 promote）。
  const kfcDist = path.join(out, 'kfc.dist');
  if (!fs.existsSync(kfcDist)) {
    console.error(`[freeze] 错误：未找到 ${kfcDist}（nuitka 产物布局变化？）`);
    process.exit(1);
  }
  fs.rmSync(distKfc, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(distKfc), { recursive: true });
  fs.renameSync(kfcDist, distKfc);

  // nuitka standalone 入口名为 kfc.bin(Unix)/kfc.exe(Win)；app 栈按 'kfc'(Unix)/'kfc.exe'(Win)
  // 定位可执行（framework/api pathConfig/processUtils 的 kfcName）。Win 已匹配；Unix 把
  // kfc.bin 重命名为 kfc（用 rename 不用符号链，保持 nuitka 产物无符号链、electron-builder 打包干净）。
  if (!isWin) {
    const binPath = path.join(distKfc, 'kfc.bin');
    const kfcPath = path.join(distKfc, 'kfc');
    if (fs.existsSync(binPath)) fs.renameSync(binPath, kfcPath);
  }

  copyAppNative(bt);
  copyPyBindingWin(bt);
  console.log('[freeze] ✅ dist/kfc 就绪（nuitka 扁平产物 + app native）');
}

// ------------------------------------------------------------- pyinstaller

function freezePyinstaller(bt) {
  stage();
  ensureBuildInfo(bt);
  console.log(`[freeze] pyinstaller kfc.spec (CMAKE_BUILD_TYPE=${bt})`);
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
      path.join('src', 'python', 'kfc.spec'),
    ],
    true,
    {
      cwd: CORE,
      env: {
        ...process.env,
        CMAKE_BUILD_TYPE: bt,
        KFC_PYI_HOOKS_PATH: path.join(CORE, 'src', 'python', 'pyi-hooks'),
      },
    },
  );
  mergeKfs();
  promote();
  console.log('[freeze] ✅ dist/kfc 就绪（pyinstaller 扁平视图 + _internal 真身）');
}

// MERGE 模式下 kfs 与 kfc 共享 _internal，dist/kfs 仅余 kfs 入口，拷进 kfc 后删除。
function mergeKfs() {
  const distKfc = path.join(CORE, 'dist', 'kfc');
  const distKfs = path.join(CORE, 'dist', 'kfs');
  if (!fs.existsSync(distKfs)) return;
  console.log('[freeze] 合并 kfs → kfc');
  for (const f of fs.readdirSync(distKfs)) {
    if (!f.includes('kfs')) continue;
    const from = path.join(distKfs, f);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(distKfc, f));
  }
  fs.rmSync(distKfs, { recursive: true, force: true });
}

// _internal/* 在 dist/kfc 顶层补一层视图，满足 app 栈的扁平布局假设（仅 pyinstaller 路径）。
function promote() {
  const distKfc = path.join(CORE, 'dist', 'kfc');
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
    if (existsLstat(top)) continue; // 跳过 pyinstaller 已放在顶层的项（kfc/kfs exe 等）
    if (isWin) {
      fs.cpSync(path.join(internal, entry), top, { recursive: true });
    } else {
      fs.symlinkSync(path.join('_internal', entry), top);
    }
    n++;
  }
  console.log(`[freeze] promote 完成：${n} 项`);
}

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
