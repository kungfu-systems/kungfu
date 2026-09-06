// SPDX-License-Identifier: Apache-2.0

// Repository qualification entry: Core owns its Python source layout.
// Installed native products use their packaged runtime instead.
const path = require('node:path');
module.exports = path.resolve(__dirname, '..', 'src', 'python');
