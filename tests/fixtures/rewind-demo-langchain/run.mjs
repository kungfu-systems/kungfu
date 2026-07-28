// SPDX-License-Identifier: Apache-2.0
//
// Real-framework capture fixture (Rewind next-falsification main item): one
// command wraps an *unmodified* LangChain agent — the langgraph `create_agent`
// runtime with a `ChatOpenAI` model and a real `BaseTool` — and produces a
// local run store whose journal carries the model turns (wire proxy) and the
// tool call (in-process adapter patching `BaseTool.run`). Asserted by
// check_capture.py. This replaces the toy toolkit as the moat evidence for
// zero-code-change capture: the toy proved the mechanism, this proves it on a
// framework kungfu does not control.
//
// The real framework is provisioned into a cached, git-ignored venv. The gate
// genuinely requires it: if langchain cannot be provisioned this fixture FAILS
// loudly rather than silently passing — a real-framework claim must be backed
// by a real framework.
//
// Usage: node tests/fixtures/rewind-demo-langchain/run.mjs
//   Requires the core dev environment (built dist/kungfu) and network on first run
//   to install langchain; the run itself uses a deterministic mock model.

import fs from 'node:fs';
import path from 'node:path';
import {
  locate,
  tmpDir,
  background,
  waitForFile,
  kfc,
  uvPython,
  run,
  fail,
  extractPackedKfx,
  kfxQualificationHostDescriptorFile,
} from '../_harness.mjs';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const { fixtureDir, coreDir } = locate(import.meta.url);
const repoDir = path.resolve(coreDir, '..', '..');

// ── provision the real framework (cached across runs) ────────────────
const venv = path.join(fixtureDir, '.venv-langchain');
const agentPy =
  process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');

const hasLangchain = () =>
  fs.existsSync(agentPy) &&
  run(agentPy, ['-c', 'import langchain, langchain_openai'], {
    allowFail: true,
  }).status === 0;

if (!hasLangchain()) {
  console.log('[langchain-fixture] provisioning real langchain venv (first run)…');
  run('uv', ['venv', venv, '--python', '3.13']);
  run('uv', ['pip', 'install', '-q', '-r', path.join(fixtureDir, 'requirements.txt')], {
    env: { VIRTUAL_ENV: venv },
  });
}
if (!hasLangchain()) {
  fail('real langchain framework unavailable');
}

const home = tmpDir('rewind-langchain-');
const runId = `fixturelangchain${Date.now()}`;

// Adapter injection is an in-process host launch, so a workspace directory or
// package name grants no authority. Exercise the same pack, exact-root
// qualification and Core registry path a real installation uses, then bind the
// trace to the resulting current host descriptor.
const packdir = tmpDir('rewind-langchain-pack-');
const extDir = path.join(repoDir, 'extensions', 'langchain-adapter');
const packed = run('npm', ['pack', '--pack-destination', packdir], { cwd: extDir });
const tgzName = packed.stdout.trim().split(/\r?\n/).pop();
const tgz = path.join(packdir, tgzName);
if (!fs.existsSync(tgz)) fail('npm pack produced no LangChain adapter tgz');
const packedRoot = extractPackedKfx(coreDir, tgz);
const hostDescriptor = kfxQualificationHostDescriptorFile(
  coreDir,
  home,
  packedRoot,
  'langchain-adapter',
  'python',
);

// deterministic model upstream: the mock (stdlib only, system python3) binds an
// ephemeral port and reports it; the supervisor picks it up as the openai
// forward target and points the child's ChatOpenAI at its own proxy.
const portFile = path.join(home, 'mock-port');
background(PY, [path.join(fixtureDir, 'mock_model.py'), portFile]);
const port = waitForFile(portFile);
const openaiBaseUrl = `http://127.0.0.1:${port}/v1`;

// The adapter remains product-disabled without an explicit runtime grant. This
// qualification-only descriptor proves the authorized capture path while the
// exact package-root check prevents a same-key workspace package from borrowing
// authority issued to different bytes.
const extRoot = path.resolve(repoDir, 'extensions');
const kfExtensionPath = process.env.KF_EXTENSION_PATH
  ? `${extRoot}${path.delimiter}${process.env.KF_EXTENSION_PATH}`
  : extRoot;

kfc(
  coreDir,
  home,
  ['trace', '--run-id', runId, '--', agentPy, path.join(fixtureDir, 'langchain_agent.py')],
  {
    env: {
      OPENAI_BASE_URL: openaiBaseUrl,
      // the openai SDK refuses to construct a client without a key; the proxy
      // never forwards request headers, so this dummy never leaves the machine
      OPENAI_API_KEY: 'sk-langchain-fixture',
      KF_KFX_HOST_DESCRIPTOR: hostDescriptor,
      KF_EXTENSION_PATH: kfExtensionPath,
    },
  },
);

uvPython(coreDir, [
  path.join(fixtureDir, 'check_capture.py'),
  path.join(home, 'runtime'),
  runId,
]);
