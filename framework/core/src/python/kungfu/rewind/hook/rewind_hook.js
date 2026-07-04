// SPDX-License-Identifier: Apache-2.0
//
// Capture layer L2, child side for Node — pure node built-ins, zero deps.
// The Node counterpart of sitecustomize.py: the supervisor injects it via
// NODE_OPTIONS="--require .../rewind_hook.js". Same two hard rules as the
// python hook: never break or slow the traced program (every operation is
// best-effort; the first failure disables emission), and depend on nothing
// beyond the runtime's built-ins.
//
// Cross-runtime causality: KUNGFU_REWIND_PARENT_SPAN carries the calling
// runtime's active span across the process boundary (the python adapter sets
// it around cross-process tool execution); spans created here root under it,
// so one causal chain spans both runtimes inside the same journal.
'use strict';
// @ts-check

const net = require('net');
const crypto = require('crypto');
const Module = require('module');

const endpoint = process.env.KUNGFU_REWIND_INGEST;
const bootParent = process.env.KUNGFU_REWIND_PARENT_SPAN || null;

if (endpoint) {
  /** @type {import('net').Socket | null} */
  let sock = null;
  let dead = false;
  /** @type {string[]} */
  const pending = [];

  const [host, port] = (() => {
    const i = endpoint.lastIndexOf(':');
    return [endpoint.slice(0, i), Number(endpoint.slice(i + 1))];
  })();

  const connect = () => {
    // Hold the created socket in a local so the connect handler writes to this
    // exact connection even if `sock` is later nulled by the error handler
    // (also lets @ts-check narrow away the Socket | null union).
    const s = net.createConnection({ host, port, timeout: 1000 });
    sock = s;
    s.on('connect', () => {
      for (const line of pending.splice(0)) s.write(line);
    });
    s.on('error', () => {
      dead = true;
      sock = null;
    });
    s.unref(); // never keep the traced process alive
  };
  connect();

  /** @param {unknown} message */
  const emit = (message) => {
    if (dead) return;
    const line = JSON.stringify(message) + '\n';
    try {
      if (sock && !sock.connecting) sock.write(line);
      else pending.push(line);
    } catch (e) {
      dead = true;
    }
  };

  const newSpan = () => crypto.randomBytes(16).toString('hex');

  /**
   * @param {string} toolName
   * @param {string | null} parentSpan
   * @param {string | null} retryOf
   * @param {number} attempt
   * @param {string} input
   * @param {() => any} fn
   * @returns {{ result: any, spanId: string }}
   */
  const captureInvoke = (toolName, parentSpan, retryOf, attempt, input, fn) => {
    const spanId = newSpan();
    if (retryOf) {
      emit({
        event: 'retry',
        span_id: spanId,
        retry_of_span_id: retryOf,
        attempt,
      });
    }
    emit({
      event: 'tool_call',
      span_id: spanId,
      parent_span_id: parentSpan,
      tool_name: toolName,
      input,
    });
    const started = process.hrtime.bigint();
    /**
     * @param {string} status
     * @param {string | null} output
     * @param {string | null} error
     */
    const done = (status, output, error) =>
      emit({
        event: 'tool_result',
        span_id: spanId,
        status,
        output,
        error,
        latency_ns: Number(process.hrtime.bigint() - started),
      });
    try {
      const result = fn();
      done('ok', render(result), null);
      return { result, spanId };
    } catch (e) {
      const err = /** @type {Error} */ (e);
      done('error', null, `${err.name || 'Error'}: ${err.message || err}`);
      throw e;
    }
  };

  /** @param {unknown} value */
  const render = (value) => {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  };

  // ── post-require adapters (mini require-in-the-middle) ──────────
  /**
   * @param {any} exports the loaded demo-toolkit module (arbitrary shape)
   * @returns {any}
   */
  const patchDemoToolkit = (exports) => {
    const originalRun = exports.Tool.prototype.run;
    const originalInvoke = exports.Tool.prototype._invoke;
    let attempt = 0;
    /** @type {string | null} */
    let prevSpan = null;

    exports.Tool.prototype.run = function (/** @type {any} */ toolInput) {
      attempt = 0;
      prevSpan = null;
      return originalRun.call(this, toolInput);
    };
    exports.Tool.prototype._invoke = function (/** @type {any} */ toolInput) {
      attempt += 1;
      const { result, spanId } = captureInvoke(
        this.name,
        bootParent,
        attempt > 1 ? prevSpan : null,
        attempt,
        render(toolInput),
        () => originalInvoke.call(this, toolInput),
      );
      prevSpan = spanId;
      return result;
    };
    return exports;
  };

  // The demo toolkit is the built-in mechanism probe; real framework adapters
  // are kfx packages the supervisor discovers and announces.
  /** @type {Record<string, (exports: any) => any>} */
  const ADAPTERS = { rewind_demo_toolkit: patchDemoToolkit };

  /**
   * @param {string} name
   * @param {(exports: any) => any} patcher
   */
  const registerAdapter = (name, patcher) => {
    ADAPTERS[name] = patcher;
  };

  // Expose the capture API to plugin adapters loaded later. A node kfx adapter
  // reads globalThis.__kungfuRewind (it depends on nothing else) and registers
  // its patcher — the node analogue of the python hook's importable primitives.
  /** @type {any} */ (globalThis).__kungfuRewind = {
    registerAdapter,
    captureInvoke,
    newSpan,
    render,
    parentSpan: bootParent,
  };

  // Load the node kfx adapter plugins the supervisor announced; requiring each
  // registers its patchers before the require hook below goes live. A broken
  // adapter must never break the traced program.
  for (const entry of (process.env.KUNGFU_REWIND_NODE_ADAPTERS || '').split(
    require('path').delimiter,
  )) {
    if (!entry) continue;
    try {
      require(entry);
    } catch (e) {
      /* best-effort: skip a broken kfx adapter */
    }
  }

  // Module._load is an internal, undocumented API absent from @types/node,
  // so the module object is cast to any to reach it (require-in-the-middle).
  const ModuleInternal = /** @type {any} */ (Module);
  const originalLoad = ModuleInternal._load;
  ModuleInternal._load = function (
    /** @type {string} */ request,
    /** @type {any} */ parent,
    /** @type {boolean} */ isMain,
  ) {
    const exports = originalLoad.apply(this, arguments);
    try {
      const name = request.replace(/\.js$/, '').split(/[\\/]/).pop();
      const patcher = name ? ADAPTERS[name] : undefined;
      if (patcher && !exports.__rewind_patched__) {
        Object.defineProperty(exports, '__rewind_patched__', { value: true });
        return patcher(exports);
      }
    } catch (e) {
      // adapters must never break the user's require
    }
    return exports;
  };
}
