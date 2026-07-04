// The page that runs inside a sandboxed kfx's isolated renderer. Under
// nodeIntegration:false / contextIsolation:true / sandbox:true this page has no
// node and no require — its only inbound surface is window.__kfxBridge (the
// declared capability keys + an invoke fn + an event subscription, from the
// sandbox preload). It:
//   - builds the ergonomic capability object from the bridge with the api guest
//     (createCapabilityGuest), so the view codes against caps.* not raw IPC;
//   - waits for main to inject the view bundle source (main is trusted; it reads
//     the file and hands this page a string via __kfxHarness.load, so fs/require
//     are never exposed to the sandbox);
//   - CommonJS-wraps the bundle with a require shim that supplies exactly the
//     externals the shell contract injects (one React, the capability surface),
//     then mounts the view's <View caps shell/> in a real React root — proving
//     the third-party bundle renders live inside the isolated renderer.
//
// Shell bridging (navigation, settings, shared refresh) is a follow-up; the
// capability boundary — the security-critical surface — is fully wired here.
import * as capability from '@kungfu-tech/api/capability';
import { createCapabilityGuest } from '@kungfu-tech/api/capability';
import type {
  KfxCapabilities,
  KfxViewComponent,
  Shell,
} from '@kungfu-tech/kfx';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import { type SandboxBridge, bridgeChannel } from '../../sandbox/transport';

declare global {
  interface Window {
    __kfxBridge: SandboxBridge;
    __kfxHarness: {
      caps: Record<string, unknown>;
      bridge: SandboxBridge;
      load: (code: string) => void;
      fail: (message: string) => void;
    };
  }
}

const bridge = window.__kfxBridge;
// exactly the declared capabilities, each call marshalled over the bridge
const caps = createCapabilityGuest(bridge.declared, bridgeChannel(bridge));

// The externals a `kungfu sdk kfx build` bundle expects, same contract as the shared
// renderer: one React instance and the capability surface. A sandboxed view that
// tries to require anything else fails loudly rather than reaching node.
const shared: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': { createRoot },
  'react/jsx-runtime': jsxRuntime,
  '@kungfu-tech/api': capability,
  '@kungfu-tech/api/capability': capability,
};

// A minimal shell for the sandboxed view. Only the capability boundary is wired;
// the rest is inert until shell bridging lands.
const shell: Shell = {
  open: () => {},
  params: {},
  onRefresh: () => () => {},
  setting: () => '',
  updateState: () => {},
  state: { profileId: '', disabledKfx: [], disabledSuites: [], settings: {} },
  info: {
    ok: true,
    message: 'sandboxed',
    runtimeDir: '',
    kfcVersion: '',
    buildInfo: null,
    exports: [],
    longfistTypes: [],
  },
  registry: [],
  suites: {},
  profiles: [],
};

function rootEl(): HTMLElement {
  let el = document.getElementById('root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'root';
    document.body.appendChild(el);
  }
  return el;
}

function fail(message: string): void {
  rootEl().textContent = `sandboxed view failed: ${message}`;
}

function load(code: string): void {
  try {
    const requireShim = (id: string): unknown => {
      if (id in shared) return shared[id];
      throw new Error(
        `sandboxed bundle requires "${id}" which the harness does not provide — it must be bundled by \`kungfu sdk kfx build\` or added to the externals contract`,
      );
    };
    const module = { exports: {} as { View?: KfxViewComponent } };
    // The bundle is CommonJS-wrapped exactly like the shared-renderer loader;
    // the sandbox strips node regardless, so this eval reaches nothing but the
    // injected externals and the declared capabilities.
    new Function('require', 'module', 'exports', code)(
      requireShim,
      module,
      module.exports,
    );
    const View = module.exports.View;
    if (typeof View !== 'function') {
      throw new Error('bundle does not export a View component');
    }
    createRoot(rootEl()).render(
      React.createElement(View, {
        caps: caps as unknown as KfxCapabilities,
        shell,
      }),
    );
  } catch (e) {
    fail((e as Error).message);
  }
}

window.__kfxHarness = { caps, bridge, load, fail };
