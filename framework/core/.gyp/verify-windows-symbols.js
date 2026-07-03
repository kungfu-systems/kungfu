// SPDX-License-Identifier: Apache-2.0
//
// Release constraint: every kungfu-compiled native shipped into dist/kfc on
// Windows MUST have its PDB alongside it. Without the PDB the field crash
// stackwalker can only print module+offset instead of function names and source
// lines (see docs/windows-crash-symbols.md).
//
// This is the enforcement point. It exits non-zero when a required PDB is
// missing so a broken release fails loudly at freeze time instead of silently
// shipping crash reports that cannot be symbolized in the field.
//
// Usage:
//   node .gyp/verify-windows-symbols.js [dist-kfc-dir]
// or from the freeze pipeline:
//   const { verifyWindowsSymbols } = require('./verify-windows-symbols');
//   verifyWindowsSymbols(path.join(CORE, 'dist', 'kfc'));

const fs = require('fs');
const path = require('path');

// Natives kungfu compiles from source and therefore owns the PDBs for. The
// C++ core (libkungfu / libyijinjing, including the stackwalker) is linked
// statically into these on Windows, so their PDBs cover the whole native side.
// Third-party natives (libnode.dll, link_node.node) are intentionally excluded:
// they ship without PDBs of ours.
const REQUIRED = [
  /^kungfu_node\.node$/i,
  /^kungfu_electron\.node$/i,
  /^drone\.node$/i,
  /^pykungfu.*\.pyd$/i,
];

// The linker PDB is named after the target's output base, so accept
// "<module>.pdb" as well as an ABI-suffixed "<module>.<abi>.pdb".
function hasSiblingPdb(dir, binName, pdbNames) {
  const stem = binName.replace(/\.(node|pyd)$/i, '').split('.')[0].toLowerCase();
  return pdbNames.some((p) => p.toLowerCase().startsWith(stem));
}

function verifyWindowsSymbols(distKfc) {
  const entries = fs.existsSync(distKfc) ? fs.readdirSync(distKfc) : [];
  const pdbNames = entries.filter((f) => /\.pdb$/i.test(f));
  const missing = [];
  for (const re of REQUIRED) {
    const bin = entries.find((f) => re.test(f));
    if (!bin) continue; // this native is not part of the current build target set
    if (!hasSiblingPdb(distKfc, bin, pdbNames)) missing.push(bin);
  }
  if (missing.length) {
    console.error(
      `[verify-windows-symbols] FAIL: native(s) shipped without a PDB in ${distKfc}:\n` +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\nWindows crash reports for these cannot be symbolized. Build with debug ' +
        'info (/Z7 + /DEBUG, see .cmake/compiler.cmake) and ship the PDB alongside ' +
        'the binary. See docs/windows-crash-symbols.md.',
    );
    process.exit(1);
  }
  console.log('[verify-windows-symbols] ok: every shipped kungfu native has a PDB');
}

module.exports = { verifyWindowsSymbols };

if (require.main === module) {
  const dir = process.argv[2] || path.resolve(__dirname, '..', 'dist', 'kfc');
  verifyWindowsSymbols(dir);
}
