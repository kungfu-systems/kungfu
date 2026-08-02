// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function playbackQuitRequested(chunk: Buffer | string): boolean {
  return /^[qQ]$/u.test(String(chunk));
}

export function projectTourTemporaryContainer(
  destination: string,
  systemTemporaryRoot = os.tmpdir(),
): string | null {
  const temporaryRoot = path.resolve(systemTemporaryRoot);
  const projectRoot = path.resolve(destination);
  const container = path.dirname(projectRoot);
  if (temporaryRoot === path.parse(temporaryRoot).root) return null;
  if (path.basename(projectRoot) !== 'my-first-kungfu-project') return null;
  if (!/^kungfu-project-tour-[a-z0-9_-]+$/iu.test(path.basename(container)))
    return null;
  if (path.dirname(container) !== temporaryRoot) return null;
  return container;
}

export function cleanupProjectTourTemporaryProject(
  destination: string,
  options: {
    systemTemporaryRoot?: string;
    remove?: (container: string) => void;
  } = {},
): string {
  const container = projectTourTemporaryContainer(
    destination,
    options.systemTemporaryRoot,
  );
  if (!container) {
    throw new Error(
      `refusing to remove unrecognized Project tour path: ${destination}`,
    );
  }
  const remove =
    options.remove ??
    ((target: string) => fs.rmSync(target, { recursive: true, force: true }));
  remove(container);
  return container;
}
