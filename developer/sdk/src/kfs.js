#!/usr/bin/env node
// kfs — the Kungfu application assembly CLI.
//
// First cut of the modern SDK surface: scaffold a complete Kungfu desktop app
// on the platform stack (electron-vite + React + the in-process runtime
// binding), wired the same way as the reference GUI. The generated app is
// self-contained; it consumes the platform through published packages, or
// through the workspace when scaffolded inside the monorepo (--workspace).
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

function readViewDecl() {
  const manifestPath = path.resolve('package.json');
  if (!fs.existsSync(manifestPath)) fail('no package.json in current directory');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const view = manifest.kungfuConfig?.config?.view;
  if (!view)
    fail('package.json has no kungfuConfig.config.view — not a view extension');
  return { manifest, view };
}

async function kfxBuild() {
  const { manifest, view } = readViewDecl();
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
  readViewDecl();
  fs.rmSync(path.resolve('dist'), { recursive: true, force: true });
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
