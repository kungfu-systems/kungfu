// SPDX-License-Identifier: Apache-2.0
//
// Node twin of the python stand-in tool framework: same natural seams
// (Tool.run = user-facing call, Tool._invoke = one attempt inside the retry
// loop), same rule — it knows nothing about kungfu or tracing; the node hook
// patches it from outside after require.
'use strict';

class Tool {
  constructor(name, fn, retries = 0) {
    this.name = name;
    this.fn = fn;
    this.retries = retries;
  }

  _invoke(toolInput) {
    return this.fn(toolInput);
  }

  run(toolInput) {
    const attempts = this.retries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return this._invoke(toolInput);
      } catch (e) {
        if (attempt === attempts - 1) throw e;
      }
    }
    return undefined;
  }
}

module.exports = { Tool };
