// IPC channel names for the sandboxed-ipc view path, kept electron-free so both
// the main-process manager and the trusted-renderer host service (and any test)
// can import them without pulling node/electron into a renderer bundle.

// main <-> trusted renderer capability host relay
export const HOST_INVOKE_CHANNEL = 'kfx:host-invoke';
export const HOST_REPLY_CHANNEL = 'kfx:host-invoke-reply';
export const HOST_EVENT_CHANNEL = 'kfx:host-event';

// shell renderer -> main: embedded WebContentsView lifecycle / layout control
export const ENSURE_CHANNEL = 'kfx:view-ensure';
export const SET_BOUNDS_CHANNEL = 'kfx:view-set-bounds';
export const SHOW_CHANNEL = 'kfx:view-show';
export const HIDE_CHANNEL = 'kfx:view-hide';
export const DESTROY_CHANNEL = 'kfx:view-destroy';
