import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// - main: externalize deps so the native binding is never bundled; it is loaded
//   via require() at runtime from kungfu-core's dist/kfc.
// - renderer: react; keep electron and the native binding external so the
//   renderer require()s them at runtime under nodeIntegration.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
});
