#!/usr/bin/env node
// kfs — the Kungfu application assembly CLI.
//
// First cut of the modern SDK surface: scaffold a complete Kungfu desktop app
// on the platform stack (electron-vite + React + the in-process runtime
// binding), wired the same way as the reference GUI. The generated app is
// self-contained; it consumes the platform through published packages, or
// through the workspace when scaffolded inside the monorepo (--workspace).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
);

function usage(code) {
  process.stdout.write(
    [
      'usage: kfs create app <directory> [options]',
      '       kfs create extension <directory> [options]',
      '       kfs kfx build | clean',
      '',
      'create options:',
      '  --name <name>   product/view name (defaults to the directory basename)',
      '  --workspace     wire platform deps as workspace:* (inside the monorepo)',
      '',
      'create extension scaffolds a view extension package (kfx): src/view/',
      'exports the View component, package.json carries the kungfuConfig',
      'manifest. kfx commands run inside such a package (a package.json with',
      'kungfuConfig.config.view); build bundles src/view/ to dist/view/index.js',
      'with react and the capability SDK left external — the shell injects',
      'its own instances at load time.',
      '',
      'kfx build also handles adapter facets (ships source), C++ extensions (a',
      'package with a CMakeLists.txt — CMake via the core conan toolchain), and',
      'Python AOT extensions (kungfuBuild.python — engage pdm install + engage',
      'nuitka --module), each producing a native module under dist/.',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`kfs: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const options = { workspace: false, name: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace') options.workspace = true;
    else if (arg === '--name') {
      i += 1;
      options.name = argv[i] || '';
    } else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

function toAppId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `com.kungfu.app.${slug.replace(/-/g, '')}`;
}

function scaffold(templateName, targetDir, replacements) {
  const templateDir = path.join(TEMPLATE_ROOT, templateName);
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // npm strips dotfiles from published packages; templates store them
      // with an underscore prefix.
      const outName = entry.name.startsWith('_')
        ? `.${entry.name.slice(1)}`
        : entry.name.replace(/\.tmpl$/, '');
      const src = path.join(from, entry.name);
      const dest = path.join(to, outName);
      if (entry.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        copy(src, dest);
      } else {
        let content = fs.readFileSync(src, 'utf8');
        for (const [token, value] of Object.entries(replacements)) {
          content = content.replaceAll(token, value);
        }
        fs.writeFileSync(dest, content);
      }
    }
  };
  fs.mkdirSync(targetDir, { recursive: true });
  copy(templateDir, targetDir);
}

function createApp(directory, options) {
  if (!directory) usage(1);
  const targetDir = path.resolve(directory);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    fail(`target directory is not empty: ${targetDir}`);
  }
  const productName = options.name || path.basename(targetDir);
  const packageName = productName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  scaffold('app', targetDir, {
    __APP_NAME__: productName,
    __APP_PACKAGE__: packageName,
    __APP_ID__: toAppId(productName),
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.0',
  });
  process.stdout.write(
    [
      `created ${productName} at ${targetDir}`,
      '',
      'next steps:',
      `  cd ${directory}`,
      '  pnpm install   # or npm/yarn',
      '  pnpm dev       # launch against a built kungfu-core (KFC_DIR to override)',
      '',
    ].join('\n'),
  );
}

function createExtension(directory, options) {
  if (!directory) usage(1);
  const targetDir = path.resolve(directory);
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    fail(`target directory is not empty: ${targetDir}`);
  }
  const extName = options.name || path.basename(targetDir);
  const extKey = extName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  scaffold('extension', targetDir, {
    __EXT_NAME__: extName,
    __EXT_KEY__: extKey,
    __KF_DEP_VERSION__: options.workspace ? 'workspace:*' : '^4.0.0-alpha.0',
  });
  process.stdout.write(
    [
      `created ${extName} at ${targetDir}`,
      '',
      'next steps:',
      `  cd ${directory}`,
      '  pnpm install   # or npm/yarn',
      '  pnpm build     # kfs kfx build -> dist/view/index.js',
      '  npm pack       # the tgz is the install unit: kungfu kfx install <tgz>',
      '',
    ].join('\n'),
  );
}

// ── kfx view extension build ──────────────────────────────────────────────
// Modules that stay external and are injected by the shell at load time; a
// view extension must never ship its own copy of these.
const KFX_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@kungfu-tech/api',
  '@kungfu-tech/api/capability',
];

function readManifest() {
  const manifestPath = path.resolve('package.json');
  if (!fs.existsSync(manifestPath)) fail('no package.json in current directory');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// ── kfx C++ extension build ────────────────────────────────────────────────
// A C++ kfx compiles src/cpp/*.cpp against the libkungfu API (headers + the
// built shared library) and its FlatBuffers data structures into a native
// pybind11 module. The extension's CMakeLists.txt includes a libkungfu-only
// helper (cmake/kungfu.cmake); this driver invokes CMake with the core's conan
// toolchain and pins the module to the core's Python so it loads in kfc.

function locateCoreDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'framework', 'core');
    if (fs.existsSync(path.join(candidate, 'conanfile.py'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runOrFail(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) fail(`${cmd} not runnable: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed (exit ${result.status ?? `signal ${result.signal}`})`);
  }
}

function cppBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir) fail('cannot locate framework/core (a cpp kfx build needs the monorepo core)');
  const toolchain = path.join(coreDir, 'build', 'conan_toolchain.cmake');
  if (!fs.existsSync(toolchain)) {
    fail(`core not built: ${toolchain} is missing. Run \`./kungfu-code rebuild:core\` first.`);
  }
  const buildDir = path.resolve('build');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'cpp');
  fs.mkdirSync(distDir, { recursive: true });
  const configureArgs = [
    '-S',
    '.',
    '-B',
    buildDir,
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_LIBRARY_OUTPUT_DIRECTORY=${distDir}`,
  ];
  // Pin the module to the core's Python (the uv-managed venv) so it is ABI-
  // compatible with the runtime and loads alongside pykungfu. Pass both the
  // classic (FindPythonInterp) and modern (FindPython) hint variables so the
  // pin holds regardless of which pybind11 lookup mode is active.
  const corePython = path.join(coreDir, '.venv', 'bin', 'python3');
  if (fs.existsSync(corePython)) {
    configureArgs.push(`-DPYTHON_EXECUTABLE=${corePython}`, `-DPython_EXECUTABLE=${corePython}`);
  }
  runOrFail('cmake', configureArgs);
  runOrFail('cmake', ['--build', buildDir, '--config', 'Release']);
  process.stdout.write(
    `built ${manifest.name ?? 'cpp extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

// ── kfx Python AOT extension build ─────────────────────────────────────────
// A Python extension (kungfuBuild.python) installs its declared dependencies
// through the bundled toolchain (`kungfu engage pdm install`) and is then
// ahead-of-time compiled into a native module (`kungfu engage nuitka
// --module`) — exercising the same python development lifecycle kfc ships.

function pythonAotBuild(manifest) {
  const coreDir = locateCoreDir(process.cwd());
  if (!coreDir) fail('cannot locate framework/core (a python-AOT kfx build needs the monorepo core)');
  const py = path.join(coreDir, '.venv', 'bin', 'python3');
  if (!fs.existsSync(py)) {
    fail(`core Python not found: ${py}. Run \`./kungfu-code rebuild:core\` first.`);
  }
  const pkgRoot = path.resolve('src', 'python');
  const pkg = fs.existsSync(pkgRoot)
    ? fs.readdirSync(pkgRoot).find((d) => fs.statSync(path.join(pkgRoot, d)).isDirectory())
    : null;
  if (!pkg) fail('no src/python/<Package>/ directory for a python-AOT extension');
  const distDir = path.resolve('dist', manifest.kungfuConfig?.key ?? 'python');
  fs.mkdirSync(distDir, { recursive: true });
  // The dev CLI resolves the `kungfu` package from src/python and its native
  // binding from build/Release; make both importable for `python -m kungfu`.
  const env = {
    ...process.env,
    PYTHONPATH: [
      path.join(coreDir, 'src', 'python'),
      path.join(coreDir, 'build', 'Release'),
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  // Install the extension's declared dependencies through the bundled pdm.
  runOrFail(py, ['-m', 'kungfu', 'engage', 'pdm', 'install'], { env });
  // AOT-compile just this module: declared deps stay runtime imports, so we do
  // not --follow-imports (we compile the extension, not its dependency tree).
  runOrFail(py, [
    '-m',
    'kungfu',
    'engage',
    'nuitka',
    '--module',
    `--output-dir=${distDir}`,
    path.join('src', 'python', pkg),
  ], { env });
  process.stdout.write(
    `built ${manifest.name ?? 'python extension'} -> ${path.relative(process.cwd(), distDir)}\n`,
  );
}

async function kfxBuild() {
  const manifest = readManifest();
  const config = manifest.kungfuConfig?.config ?? {};
  const view = config.view;
  if (!view) {
    // A C++ extension compiles native code against libkungfu into a pybind11
    // module. It is detected by a CMakeLists.txt at the package root.
    if (fs.existsSync(path.resolve('CMakeLists.txt'))) {
      cppBuild(manifest);
      return;
    }
    // A Python AOT extension declares its dependencies under kungfuBuild.python;
    // kfs installs them (engage pdm) and compiles src/python (engage nuitka).
    if (manifest.kungfuBuild?.python) {
      pythonAotBuild(manifest);
      return;
    }
    // An adapter facet is a runtime extension: it ships source per child
    // runtime (python/node) and the capture supervisor injects it — there is
    // nothing to bundle. Succeed so `kfs kfx build` is usable on any kfx.
    if (config.adapter) {
      process.stdout.write(
        `${manifest.name ?? 'adapter extension'}: adapter facet ships source (no bundle step)\n`,
      );
      return;
    }
    fail('package.json has no view/adapter facet, no CMakeLists.txt (cpp), and no kungfuBuild.python (python-AOT)');
  }
  const entry = ['src/view/index.tsx', 'src/view/index.ts'].find((candidate) =>
    fs.existsSync(path.resolve(candidate)),
  );
  if (!entry) fail('no src/view/index.tsx (or .ts) entry');
  const outfile = path.resolve(view.entry || 'dist/view/index.js');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.resolve(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    external: KFX_EXTERNALS,
    sourcemap: false,
    logLevel: 'warning',
  });
  process.stdout.write(
    `built ${manifest.name ?? 'view extension'} -> ${path.relative(process.cwd(), outfile)}\n`,
  );
}

function kfxClean() {
  readManifest();
  fs.rmSync(path.resolve('dist'), { recursive: true, force: true });
  // A cpp extension also has a CMake build tree.
  fs.rmSync(path.resolve('build'), { recursive: true, force: true });
  process.stdout.write('cleaned dist\n');
}

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, kind, directory] = positional;

if (!command) usage(1);
if (command === 'create') {
  if (kind === 'app') createApp(directory, options);
  else if (kind === 'extension') createExtension(directory, options);
  else fail(`unknown target: ${kind} (supported: app, extension)`);
} else if (command === 'kfx') {
  if (kind === 'build') await kfxBuild();
  else if (kind === 'clean') kfxClean();
  else fail(`unknown kfx command: ${kind} (supported: build, clean)`);
} else {
  fail(`unknown command: ${command}`);
}
