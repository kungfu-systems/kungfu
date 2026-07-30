import { bindAgentSessionSurfaceRpc } from '../../src/product-rpc.mjs';

const endpoint = process.env.KUNGFU_AGENT_SESSION_ENDPOINT;
const sessions = [];
const server = bindAgentSessionSurfaceRpc({
  endpoint,
  invoke(request) {
    if (request.operation === 'capabilities') {
      return { schema: 'fixture.capabilities/v1' };
    }
    if (request.operation === 'list') return { sessions: [...sessions] };
    if (request.operation === 'start') {
      sessions.push(request.sessionAttemptId);
      return { status: 'started' };
    }
    throw new Error(`unsupported fixture operation '${request.operation}'`);
  },
});
await server.ready;
process.once('SIGTERM', () => void server.close().finally(() => process.exit(0)));
