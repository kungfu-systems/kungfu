// Preload for a sandboxed kfx renderer. This is the ONLY bridge the isolated
// view gets: it runs with nodeIntegration:false, contextIsolation:true,
// sandbox:true, so the page has no node, no require, no direct capability
// binding. contextBridge exposes exactly one thing — the capability object
// built from the view's declared set, backed by the trusted host over IPC.
//
// The transport mapping lives in ../sandbox/transport (electron-free, tested);
// this file is the thin electron-only glue.
import { contextBridge, ipcRenderer } from 'electron';
import { createCapabilityGuest } from '@kungfu-tech/api/capability';

import { guestChannelOverIpc, readDeclared, type IpcRendererLike } from '../sandbox/transport';

const declared = readDeclared(process.argv);
const caps = createCapabilityGuest(
  declared,
  guestChannelOverIpc(ipcRenderer as unknown as IpcRendererLike),
);
contextBridge.exposeInMainWorld('__kfxCaps', caps);
