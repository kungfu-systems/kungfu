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
      '',
      'options:',
      '  --name <name>   product name (defaults to the directory basename)',
      '  --workspace     wire platform deps as workspace:* (inside the monorepo)',
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

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, kind, directory] = positional;

if (!command) usage(1);
if (command !== 'create') fail(`unknown command: ${command}`);
if (kind !== 'app') fail(`unknown target: ${kind} (supported: app)`);
createApp(directory, options);
