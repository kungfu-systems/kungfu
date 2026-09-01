import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export class CapsuleTransportUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CapsuleTransportUnavailableError';
    this.code = 'capsule_transport_unavailable';
  }
}

export function capsuleNodePtyCandidates({
  modulePath,
  registryPath,
  bundleDirectory = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  return [
    modulePath ? path.resolve(modulePath) : null,
    registryPath
      ? path.join(
          path.dirname(path.dirname(path.resolve(registryPath))),
          'agent-session-support',
          'node-pty',
          'lib',
          'index.js',
        )
      : null,
    path.join(bundleDirectory, 'node_modules', 'node-pty', 'lib', 'index.js'),
    path.join(
      bundleDirectory,
      '..',
      'node_modules',
      'node-pty',
      'lib',
      'index.js',
    ),
    path.join(
      bundleDirectory,
      '..',
      'app',
      'node_modules',
      'node-pty',
      'lib',
      'index.js',
    ),
  ];
}

export function createCapsuleNodePtyLoader({
  modulePath = process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE,
  registryPath = process.env.KUNGFU_AGENT_SESSION_REGISTRY,
  moduleRequire = require,
} = {}) {
  let loaded = null;
  return () => {
    if (loaded) return loaded;
    const candidates = capsuleNodePtyCandidates({ modulePath, registryPath });
    try {
      candidates.push(moduleRequire.resolve('node-pty/lib/index.js'));
    } catch {}
    const candidate = candidates.find(
      (value) => typeof value === 'string' && existsSync(value),
    );
    if (!candidate) {
      throw new CapsuleTransportUnavailableError(
        'Capsule transport requires the optional node-pty runtime; provider-native sessions remain available without it',
      );
    }
    try {
      loaded = moduleRequire(candidate);
    } catch (error) {
      throw new CapsuleTransportUnavailableError(
        `Capsule transport could not load its optional node-pty runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!loaded || typeof loaded.spawn !== 'function') {
      loaded = null;
      throw new CapsuleTransportUnavailableError(
        'Capsule transport resolved an invalid node-pty runtime',
      );
    }
    return loaded;
  };
}
