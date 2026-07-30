// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';

function pathInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function normalizeCopiedSymlinks({ source, target }) {
  const sourceRoot = fs.realpathSync(source);
  const visit = (currentTarget) => {
    for (const entry of fs.readdirSync(currentTarget, {
      withFileTypes: true,
    })) {
      const targetPath = path.join(currentTarget, entry.name);
      if (entry.isDirectory()) {
        visit(targetPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const relativePath = path.relative(target, targetPath);
      const sourcePath = path.join(sourceRoot, relativePath);
      const link = fs.readlinkSync(sourcePath);
      const resolvedSource = path.resolve(path.dirname(sourcePath), link);
      const canonicalSource = fs.realpathSync(resolvedSource);
      if (!pathInside(sourceRoot, canonicalSource)) {
        throw new Error(
          `product input contains an escaping symlink: ${sourcePath}`,
        );
      }
      const resolvedTarget = path.join(
        target,
        path.relative(sourceRoot, canonicalSource),
      );
      const portableLink =
        path.relative(path.dirname(targetPath), resolvedTarget) || '.';
      fs.unlinkSync(targetPath);
      fs.symlinkSync(portableLink, targetPath);
    }
  };
  visit(target);
}
