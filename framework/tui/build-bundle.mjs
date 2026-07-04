// SPDX-License-Identifier: Apache-2.0
//
// Bundle the Ink TUI into a single self-contained ES module so the packaged app
// can run it through kungfu's embedded Node runtime (libnode) with no
// node_modules. ESM output is required: Ink 5 and yoga-layout use top-level
// await, which the CJS format cannot represent. The kungfu_node binding is
// loaded at runtime by absolute path (a dynamic require esbuild leaves alone),
// so it stays external.
// @ts-check

import esbuild from 'esbuild';

// Ink statically imports react-devtools-core for its optional devtools
// integration, but it is an unused optional dependency here. Stub it to an
// empty module so the bundle is self-contained.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  /**
   * esbuild plugin setup hook. `build` is esbuild's PluginBuild object; it
   * is typed as `any` here because esbuild ships no types in this checkout.
   * @param {any} build
   * @returns {void}
   */
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export function connectToDevTools() {}\nexport default {};\n',
      loader: 'js',
    }));
  },
};

await esbuild.build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/tui.mjs',
  plugins: [stubDevtools],
  // Bundled CJS deps (signal-exit, etc.) call require() for Node builtins;
  // give the ESM bundle a real require so esbuild's shim falls back to it.
  banner: {
    js: [
      "import { createRequire as __kfCreateRequire } from 'node:module';",
      'const require = __kfCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
