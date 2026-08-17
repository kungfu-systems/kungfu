export type AgentSessionSurfaceRequest = Record<string, unknown> & {
  operation: string;
};

export type DetachedAgentSessionHost = Readonly<{
  directory: string;
  socketDirectory: string | null;
  endpoint: string;
  metadata: string;
  registry: string;
  startupLock: string;
  invoke: (
    request: AgentSessionSurfaceRequest,
  ) => Promise<Record<string, unknown>>;
}>;

export type AttachedAgentSessionHost = Readonly<
  DetachedAgentSessionHost & {
    ready: Promise<unknown>;
    close: () => Promise<void>;
  }
>;

export function detachedAgentSessionPaths(runtimeDir: string): Omit<
  DetachedAgentSessionHost,
  'invoke'
>;

export function prepareAgentSessionNodePty(options: {
  runtimeDir: string;
  modulePath?: string;
}): string;

export function createDetachedAgentSessionHost(options: {
  runtimeDir: string;
  executable?: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
  unrefWorker?: boolean;
  now?: () => number;
}): DetachedAgentSessionHost;

export function createAttachedAgentSessionHost(options: {
  runtimeDir: string;
  pty?: unknown;
  ptyModule?: string;
  env?: NodeJS.ProcessEnv;
}): AttachedAgentSessionHost;
