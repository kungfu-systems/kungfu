import { execFileSync } from 'node:child_process';
import path from 'node:path';
// Minimal Electron main process for the kungfu reference app.
//
// The C++ runtime reads configuration through std::getenv, which only sees
// environment variables present when the process starts. The renderer process
// is spawned by this main process, so the runtime directory must be exported
// here, before any window (and therefore the renderer process) is created.
import { BrowserWindow, app } from 'electron';

// Resolve the kungfu runtime directory (kfc) that holds libkungfu.dylib and the
// kungfu_electron.node binding. In development it lives in the kungfu-core
// package; once packaged it is shipped as an extraResource under Resources/kungfu.
const kungfuDir = app.isPackaged
  ? path.join(process.resourcesPath, 'kungfu')
  : path.join(
      path.dirname(require.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );

const bindingPath = path.join(kungfuDir, 'kungfu_electron.node');

// Export before the renderer process is created so both processes inherit them.
// The default runtime home must be writable: userData when packaged (never
// inside the app bundle), a throwaway directory under out/ in development.
process.env.KF_RUNTIME_DIR =
  process.env.KF_RUNTIME_DIR ||
  (app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime')
    : path.join(__dirname, '..', 'demo-runtime'));
process.env.KFE_PATH = process.env.KFE_PATH || bindingPath;

// Prove the frozen runtime CLI runs standalone next to the binding, and hand
// the result to the renderer for display.
try {
  const kungfuBin = path.join(path.dirname(process.env.KFE_PATH), 'kungfu');
  const out = execFileSync(kungfuBin, ['--version'], { timeout: 10000 });
  process.env.KUNGFU_VERSION = out.toString().trim();
} catch {
  process.env.KUNGFU_VERSION = '';
}

// Probe the binding in the main (node) process.
try {
  const kfe = require(process.env.KFE_PATH || bindingPath);
  console.log(
    `KFE_MAIN_OK loaded; exports=${Object.keys(kfe).length} [${Object.keys(kfe)
      .slice(0, 6)
      .join(',')}]`,
  );
} catch (e) {
  console.log(`KFE_MAIN_FAIL ${(e as Error).message}`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      // Moat: in-process zero-copy access to journal/state requires
      // nodeIntegration with contextIsolation/sandbox disabled.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
