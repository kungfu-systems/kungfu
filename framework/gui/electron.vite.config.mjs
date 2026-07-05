import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const rootDir = dirname(fileURLToPath(import.meta.url));
const nodeRequire = createRequire(import.meta.url);

// The trusted renderer runs under nodeIntegration, so node builtins are
// available via require() at runtime. Marking them `external` alone is not
// enough: in an ESM browser bundle an external `node:fs` stays an `import` the
// Chromium loader tries to fetch as a URL (ERR_UNKNOWN_URL_SCHEME), failing the
// whole chunk. The capability SDK's node-only host modules (the OS-sandbox
// launcher, the subprocess relay) sit in the renderer graph and are not
// tree-shaken because the shell injects the whole capability namespace. This
// plugin resolves every `node:*` (and its bare alias) to a tiny CJS shim that
// re-exports the real builtin via window.require, so those static imports load
// (and a renderer that never calls them pays nothing).
function nodeBuiltinRequireShim() {
  const PREFIX = '\0kf-node-builtin:';
  const builtins = new Set([
    'fs',
    'os',
    'path',
    'child_process',
    'readline',
    'util',
    'events',
    'stream',
    'net',
    'crypto',
    'url',
    'assert',
    'buffer',
    'tty',
  ]);
  const bare = (id) => (id.startsWith('node:') ? id.slice(5) : id);
  return {
    name: 'kf-node-builtin-require-shim',
    enforce: 'pre',
    resolveId(id) {
      const name = bare(id);
      if (id.startsWith('node:') || builtins.has(name)) return PREFIX + name;
      return null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const name = id.slice(PREFIX.length);
      // Enumerate the real builtin's exports here (the config runs in node), so
      // the generated ESM re-exports every named import a consumer might use.
      // The values come from window.require at runtime under nodeIntegration.
      let keys = [];
      try {
        const real = nodeRequire(`node:${name}`);
        keys = Object.keys(real).filter(
          (k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k),
        );
      } catch {
        keys = [];
      }
      const spec = JSON.stringify(`node:${name}`);
      return [
        `const req = (typeof window !== 'undefined' && window.require) ? window.require : null;`,
        `const m = req ? req(${spec}) : {};`,
        'export default m;',
        ...keys.map((k) => `export const ${k} = m[${JSON.stringify(k)}];`),
      ].join('\n');
    },
  };
}

// - main: externalize deps so the native binding is never bundled; it is loaded
//   via require() at runtime from kungfu-core's dist/kungfu.
// - preload: the sandbox preload — the only bridge an isolated sandboxed view
//   gets (contextBridge exposes __kfxBridge); built as its own entry.
// - renderer: react; keep electron and the native binding external so the
//   trusted renderer require()s them at runtime under nodeIntegration. Two html
//   entries: the shell (index) and the isolated sandboxed-view harness.
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@kungfu-tech/api', '@kungfu-tech/kfx', '@kungfu-tech/skill'],
      }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@kungfu-tech/api', '@kungfu-tech/kfx', '@kungfu-tech/skill'],
      }),
    ],
    build: {
      rollupOptions: {
        input: {
          sandbox: resolve(rootDir, 'src/preload/sandbox.ts'),
        },
      },
    },
  },
  renderer: {
    // nodeBuiltinRequireShim maps node:* to a window.require CJS shim (see its
    // definition above); electron stays external and is require()d at runtime.
    plugins: [nodeBuiltinRequireShim(), react()],
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          index: resolve(rootDir, 'src/renderer/index.html'),
          'sandbox-view-harness': resolve(
            rootDir,
            'src/renderer/sandbox-view-harness/index.html',
          ),
        },
      },
    },
  },
});
