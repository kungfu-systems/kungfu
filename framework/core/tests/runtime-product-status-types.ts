// SPDX-License-Identifier: Apache-2.0

import createKungfuRuntime = require('../lib/kungfu');

declare const status: createKungfuRuntime.RuntimeProductStatus;

if (status.liveState === 'inactive') {
  status.handle satisfies null;
  status.error satisfies null;
} else if (status.liveState === 'failed') {
  status.error.code satisfies string;
} else {
  status.handle.generation satisfies string;
  status.error satisfies null;
}
