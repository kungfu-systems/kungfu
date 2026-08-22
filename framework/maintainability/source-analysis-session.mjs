// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  functionSnapshot as analyzeSnapshot,
  digest,
  git,
  languageFamily,
} from './source-analysis-kernel.mjs';

function trackedCurrentPaths(paths) {
  return [...new Set(paths)]
    .filter(
      (pathname) =>
        languageFamily(pathname) && fs.existsSync(path.join(ROOT, pathname)),
    )
    .sort()
    .map((pathname) => ({
      path: pathname,
      bytes: fs.readFileSync(path.join(ROOT, pathname)),
    }));
}

function trackedFilesAtPaths(ref, paths) {
  const eligible = [...new Set(paths)].filter(languageFamily).sort();
  if (!eligible.length) return [];
  const entries = String(
    git([
      'ls-tree',
      '-r',
      '-z',
      '--format=%(objectname)%x09%(path)',
      ref,
      '--',
      ...eligible,
    ]),
  )
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { oid: entry.slice(0, tab), path: entry.slice(tab + 1) };
    });
  if (!entries.length) return [];
  const output = git(['cat-file', '--batch'], {
    binary: true,
    input: Buffer.from(`${entries.map(({ oid }) => oid).join('\n')}\n`),
  });
  let offset = 0;
  return entries.map(({ path: pathname }) => {
    const headerEnd = output.indexOf(10, offset);
    const size = Number(
      output.subarray(offset, headerEnd).toString('utf8').split(' ')[2],
    );
    if (!Number.isInteger(size))
      throw new Error(`invalid Git object for ${pathname}`);
    const start = headerEnd + 1;
    const bytes = Buffer.from(output.subarray(start, start + size));
    offset = start + size + 1;
    return { path: pathname, bytes };
  });
}

function functionSnapshot(files, policy, layers, ownership, options = {}) {
  if (!options.analysisMemo)
    return analyzeSnapshot(files, policy, layers, ownership);
  const contractRoot = digest({
    includedClasses: policy.includedClasses,
    layers,
    ownership,
  });
  const parts = files
    .filter(({ path: pathname }) => languageFamily(pathname))
    .map((file) => {
      const contentRoot = digest(file.bytes);
      const key = digest({ path: file.path, contentRoot, contractRoot });
      if (options.analysisMemo.has(key)) return options.analysisMemo.get(key);
      const snapshot = analyzeSnapshot([file], policy, layers, ownership);
      const part = { file: snapshot.files[0], functions: snapshot.functions };
      options.analysisMemo.set(key, part);
      options.onExtract?.(file.path, contentRoot);
      return part;
    })
    .sort((left, right) => left.file.path.localeCompare(right.file.path));
  const fileFacts = parts.map(({ file }) => file);
  const functions = parts
    .flatMap(({ functions: values }) => values)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { sourceRoot: digest(fileFacts), files: fileFacts, functions };
}

export { functionSnapshot, trackedCurrentPaths, trackedFilesAtPaths };
