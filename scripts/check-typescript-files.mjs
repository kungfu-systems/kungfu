#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalize(file) {
  return path.resolve(file).replaceAll('\\', '/');
}

export function typeDiagnosticsForFiles(project, files, root = ROOT) {
  const projectPath = path.resolve(root, project);
  const config = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (config.error) return [config.error];

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(projectPath),
    undefined,
    projectPath,
  );
  if (parsed.errors.length) return parsed.errors;

  const targets = new Set(
    files.map((file) => normalize(path.resolve(root, file))),
  );
  const included = new Set(parsed.fileNames.map(normalize));
  const missing = [...targets].filter((file) => !included.has(file));
  if (missing.length) {
    throw new Error(
      `files are outside ${path.relative(root, projectPath)}: ${missing
        .map((file) => path.relative(root, file))
        .join(', ')}`,
    );
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file && targets.has(normalize(diagnostic.file.fileName)),
    );
}

function parseArgs(argv) {
  const projectIndex = argv.indexOf('--project');
  if (projectIndex === -1 || !argv[projectIndex + 1]) {
    throw new Error(
      'usage: check-typescript-files.mjs --project <tsconfig> <files...>',
    );
  }
  const project = argv[projectIndex + 1];
  const files = argv.filter(
    (_arg, index) => index !== projectIndex && index !== projectIndex + 1,
  );
  if (!files.length)
    throw new Error('at least one TypeScript file is required');
  return { project, files };
}

function main() {
  const { project, files } = parseArgs(process.argv.slice(2));
  const diagnostics = typeDiagnosticsForFiles(project, files);
  if (diagnostics.length) {
    process.stderr.write(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => '\n',
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[typescript-files] project=${project} checked=${files.length} passed`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[typescript-files] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
