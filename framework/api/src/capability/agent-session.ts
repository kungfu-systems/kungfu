export type AgentSessionSurfaceRequest = {
  operation: string;
  [key: string]: unknown;
};

export type AgentSessionSurfaceResponse = Record<string, unknown>;

/**
 * The product-facing Agent Session capability is deliberately one invoke
 * method: GUI, CLI and KFD-3 clients send the same self-describing action and
 * receive the same plan/status/receipt schema. Presentation code does not gain
 * a private spawn or PTY write method.
 */
export type AgentSession = {
  invoke: (
    request: AgentSessionSurfaceRequest,
  ) => AgentSessionSurfaceResponse | Promise<AgentSessionSurfaceResponse>;
};

export function openAgentSession(options: {
  invoke: AgentSession['invoke'];
}): AgentSession {
  return Object.freeze({ invoke: options.invoke });
}
