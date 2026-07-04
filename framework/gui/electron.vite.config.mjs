import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const rootDir = dirname(fileURLToPath(import.meta.url));

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
        exclude: ['@kungfu-tech/api', '@kungfu-tech/kfx'],
      }),
    ],
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@kungfu-tech/api', '@kungfu-tech/kfx'],
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
    plugins: [react()],
    build: {
      rollupOptions: {
        // The trusted renderer runs under nodeIntegration, so keep electron and
        // the node builtins external — they are require()d at runtime. The
        // capability SDK re-exports node-only host modules (the OS-sandbox
        // launcher, the subprocess relay) that a renderer never invokes; leaving
        // node: builtins external lets those modules sit in the graph without
        // the browser build trying to bundle node:fs / node:os.
        external: ['electron', /^node:/],
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
