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

// renderer <-> main: the managed session (terminal) host relay (ADR-0016). Its
// own channels, separate from the sandbox relay, and terminal-specific so a
// per-subscription stop() round-trips (the shared relay only bulk-disposes).
export const TERMINAL_CALL_CHANNEL = 'kf-terminal:call';
export const TERMINAL_SUBSCRIBE_CHANNEL = 'kf-terminal:subscribe';
export const TERMINAL_UNSUBSCRIBE_CHANNEL = 'kf-terminal:unsubscribe';
export const TERMINAL_EVENT_CHANNEL = 'kf-terminal:event';

// shell renderer <-> main: per-session OS window lifecycle (ADR-0016 stage 2).
// The shell asks main to pop a session out into its own window or to restore
// the saved set; main pushes a snapshot back on every open-set/bounds change so
// the shell persists WorkspaceLayout.windows[]. OS window bounds live in main
// (only it owns the BrowserWindow), but the durable record stays a renderer
// config fact, so the two exchange it over these channels.
export const SESSION_WINDOW_OPEN_CHANNEL = 'kf-session-window:open';
export const SESSION_WINDOW_RESTORE_CHANNEL = 'kf-session-window:restore';
export const SESSION_WINDOW_CLOSE_CHANNEL = 'kf-session-window:close';
export const SESSION_WINDOW_SNAPSHOT_CHANNEL = 'kf-session-window:snapshot';

// shell renderer <-> main: narrow window chrome bridge. The renderer owns the
// custom titlebar UI; main owns native BrowserWindow state and controls.
export const WINDOW_CHROME_GET_CHANNEL = 'kf-window-chrome:get';
export const WINDOW_CHROME_CONTROL_CHANNEL = 'kf-window-chrome:control';
export const WINDOW_CHROME_STATE_CHANNEL = 'kf-window-chrome:state';

export const RUNTIME_STATUS_GET_CHANNEL = 'kf-runtime-status:get';

// renderer <-> main: Desktop Workspace chooser/switcher. Selection is a
// global-config convenience record; fact-bearing data remains in the selected
// Home or project workspace and switching relaunches the single-workspace app.
export const WORKSPACE_GET_CHANNEL = 'kf-workspace:get';
export const WORKSPACE_OPEN_CHANNEL = 'kf-workspace:open';
export const WORKSPACE_SELECT_HOME_CHANNEL = 'kf-workspace:select-home';
export const WORKSPACE_SELECT_RECENT_CHANNEL = 'kf-workspace:select-recent';
export const WORKSPACE_CREATE_MISSION_CHANNEL = 'kf-workspace:create-mission';
