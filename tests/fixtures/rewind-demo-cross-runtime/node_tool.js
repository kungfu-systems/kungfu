// SPDX-License-Identifier: Apache-2.0
//
// The Node side of the cross-runtime demo: an unmodified "tool process" that
// uses the stand-in framework to do one lookup and prints the result. It never
// mentions kungfu — the hook arrives through NODE_OPTIONS, the causal parent
// through the environment, exactly as an SDK-free user process would see it.
'use strict';

const { Tool } = require('./rewind_demo_toolkit.js');

const input = JSON.parse(process.argv[2] || '{}');
const tool = new Tool('node-lookup', (i) => ({ answer: String(i.query || '').split('').reverse().join('') }));
process.stdout.write(JSON.stringify(tool.run(input)));
