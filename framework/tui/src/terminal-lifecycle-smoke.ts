// SPDX-License-Identifier: Apache-2.0

import { Text, render } from 'ink';
import React from 'react';
import { TerminalLifecycle } from './terminal-lifecycle.js';

const lifecycle = new TerminalLifecycle(process.stdin, process.stdout, process);
lifecycle.start({ onExit: () => undefined, onResize: () => undefined });
const instance = render(
  React.createElement(Text, null, 'PTY-LIFECYCLE-SMOKE'),
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  },
);
instance.unmount();
lifecycle.restore();
