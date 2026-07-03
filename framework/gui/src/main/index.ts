import { execFileSync } from 'node:child_process';
import path from 'node:path';
// Minimal Electron main process for the kungfu reference app.
//
// The C++ runtime reads configuration through std::getenv, which only sees
// environment variables present when the process starts. The renderer process
// is spawned by this main process, so the runtime directory must be exported
// here, before any window (and therefore the renderer process) is created.
import {
  BrowserWindow,
  Menu,
  WebContentsView,
  app,
  dialog,
  ipcMain,
} from 'electron';

import {
  DESTROY_CHANNEL,
  ENSURE_CHANNEL,
  HIDE_CHANNEL,
  SET_BOUNDS_CHANNEL,
  SHOW_CHANNEL,
} from '../sandbox/channels';
import { type Rect, SandboxManager } from './sandbox-manager';
import {
  installKungfuCliToPath,
  uninstallKungfuCliFromPath,
} from './installCli';

// Resolve the kungfu runtime directory that holds libkungfu.dylib and the
// kungfu_electron.node binding. In development it lives in the kungfu-core
// package; once packaged it is shipped as an extraResource under Resources/kungfu.
const kfcDir = app.isPackaged
  ? path.join(process.resourcesPath, 'kungfu')
  : path.join(
      path.dirname(require.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );

const bindingPath = path.join(kfcDir, 'kungfu_electron.node');

// Export before the renderer process is created so both processes inherit them.
// The default runtime home must be writable: userData when packaged (never
// inside the app bundle), a throwaway directory under out/ in development.
process.env.KF_RUNTIME_DIR =
  process.env.KF_RUNTIME_DIR ||
  (app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime')
    : path.join(__dirname, '..', 'demo-runtime'));
process.env.KFE_PATH = process.env.KFE_PATH || bindingPath;
// Extension roots for the renderer's kfx loader. Installed extensions live
// next to the runtime home (<home>/extensions, populated by `kungfu kfx
// install`); in development the workspace extensions/ tree is the default
// source so the System Suite and the built-in views load from source builds.
process.env.KF_EXTENSION_PATH =
  process.env.KF_EXTENSION_PATH ||
  (app.isPackaged
    ? ''
    : path.join(__dirname, '..', '..', '..', '..', 'extensions'));

// Prove the frozen runtime CLI runs standalone next to the binding, and hand
// the result to the renderer for display.
try {
  const kfcBin = path.join(path.dirname(process.env.KFE_PATH), 'kungfu');
  const out = execFileSync(kfcBin, ['--version'], { timeout: 10000 });
  process.env.KFC_VERSION = out.toString().trim();
} catch {
  process.env.KFC_VERSION = '';
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

// The isolated sandboxed-view harness page. In dev it is served by the renderer
// dev server; once built it sits beside the main renderer under out/renderer.
function harnessEntry(): string {
  return process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/sandbox-view-harness/index.html`
    : `file://${path.join(__dirname, '../renderer/sandbox-view-harness/index.html')}`;
}

// The embedded-view manager is created per shell window; the ipcMain control
// handlers are registered once and dispatch to the current manager. This keeps
// `activate` (which re-runs createWindow) from double-registering a channel.
let manager: SandboxManager | null = null;

ipcMain.handle(ENSURE_CHANNEL, (_event, payload) => {
  const { id, bundlePath, declared } = payload as {
    id: string;
    bundlePath: string;
    declared: string[];
  };
  manager?.ensureView({ id, bundlePath, declared });
});
ipcMain.on(SET_BOUNDS_CHANNEL, (_event, payload) => {
  const { id, rect } = payload as { id: string; rect: Rect };
  manager?.setBounds(id, rect);
});
ipcMain.on(SHOW_CHANNEL, (_event, payload) => {
  manager?.show((payload as { id: string }).id);
});
ipcMain.on(HIDE_CHANNEL, (_event, payload) => {
  manager?.hide((payload as { id: string }).id);
});
ipcMain.on(DESTROY_CHANNEL, (_event, payload) => {
  manager?.destroyView((payload as { id: string }).id);
});

// Application menu with the VS Code-style "Install 'kungfu' Command in PATH"
// action, so a real user who installed Kungfu.app can use `kungfu` in a shell.
function buildMenu() {
  const cliSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Install 'kungfu' Command in PATH",
      click: async () => {
        const r = installKungfuCliToPath();
        await dialog.showMessageBox({
          type: r.ok ? 'info' : 'error',
          message: r.ok
            ? "Shell command 'kungfu' installed"
            : "Could not install 'kungfu' command",
          detail: r.message,
        });
      },
    },
    {
      label: "Uninstall 'kungfu' Command from PATH",
      click: async () => {
        const r = uninstallKungfuCliFromPath();
        await dialog.showMessageBox({
          type: r.ok ? 'info' : 'error',
          message: r.ok
            ? "Shell command 'kungfu' removed"
            : "Could not remove 'kungfu' command",
          detail: r.message,
        });
      },
    },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    { label: 'kungfu', submenu: cliSubmenu },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

  // The trusted renderer holds the real capabilities and runs the capability
  // host; this manager embeds sandboxed views and relays their invokes to it.
  manager = new SandboxManager({
    shell: win,
    ipcMain,
    WebContentsView,
    harnessEntry,
  });

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
